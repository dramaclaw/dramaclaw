// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { confirmDialog } from "@/components/confirm-dialog-host";
import {
  AlertTriangle,
  ChevronDown,
  Cpu,
  Eye,
  EyeOff,
  ExternalLink,
  HardDrive,
  Loader2,
  Package,
  Maximize2,
  Minimize2,
  Pencil,
  Plus,
  RotateCw,
  Trash2,
} from "lucide-react";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { safeLocalStorageSet } from "@/lib/localStorageQuota";
import { cn } from "@/lib/utils";
import {
  FEATURE_MODEL_GROUPS,
  FEATURE_MODEL_PRODUCT_GROUPS,
  type FeatureModelDef,
  type FeatureModelGroup,
} from "@/lib/feature-models";
import {
  useModelGatewayConfig,
  useOfficialMediaCatalogStatus,
  useSaveOfficialMediaCatalogPreferences,
  useCheckOfficialMediaCatalog,
  useNewApiChannelTypes,
  useEnableOfficial,
  useEnableCustom,
  useEnableHybrid,
  useEnableBrainClaw,
  useSaveOfficialConfig,
  useSaveBrainClawConfig,
  useSetCustomLlmMode,
  useInitCustomNewApi,
  useSaveCustomChannel,
  useSaveCustomChannelsBatch,
  useSaveEmbeddingModel,
  useSaveMediaModels,
  useSaveProviderChannels,
  useClearComfyUIConfig,
  useSaveMediaRelayConfig,
  useSyncProviderChannel,
  type GatewayMode,
  type CustomLlmMode,
  type ModelGatewayConfig,
  type CustomChannelInput,
  type NewApiDatabaseConfigInput,
  type NewApiChannelType,
  type SavedEmbeddingModelConfig,
  type SavedMediaModelConfig,
  type SavedProviderChannelConfig,
} from "@/lib/queries/model-gateway";
import {
  useSettingsStore,
  FEATURE_MODEL_PROVIDERS,
  type AliyunOssStorageConfig,
  type CloudinaryStorageConfig,
  type EmbeddingModelEntry,
  type FeatureModelEntry,
  type FeatureModelSettings,
  type FeatureModelProvider,
  type MediaModelEntry,
  type MediaStorageProvider,
} from "@/stores/settingsStore";
import { isCeRuntime } from "@/lib/runtime-config";
import { FreezoneSkillRecipeSettings } from "./freezone-skill-recipe-settings";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const MEDIA_STORAGE_PROVIDERS: MediaStorageProvider[] = [
  "aliyun_oss",
  "cloudinary",
];

// Codex 本地桥接暂时隐藏（保留组件代码，后端就绪后改回 true 即可恢复）。
const SHOW_CODEX_BRIDGE = false;
const MODEL_CONFIGURATION_GUIDE_URL =
  "https://github.com/dramaclaw/dramaclaw/blob/main/docs/en/getting-started/configuring-models.md";
const COMFY_WORKFLOW_MANAGED_CONFIG_KEY = "_dcManagedByWorkflow";

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const { t } = useTranslation();
  const ceRuntime = isCeRuntime();
  const [page, setPage] = useState<"models" | "storage" | "freezone-skills" | "freezone-recipes">(
    () => (ceRuntime ? "models" : "freezone-skills"),
  );
  const statusQuery = useModelGatewayConfig(open && ceRuntime);
  const settingsStatus = statusQuery.data?.data;
  const modelConfigured = Boolean(settingsStatus?.effective.configured);
  const mediaStorageConfigured = Boolean(
    settingsStatus?.mediaRelay?.configured,
  );

  useEffect(() => {
    if (!ceRuntime && (page === "models" || page === "storage")) {
      setPage("freezone-skills");
    }
  }, [ceRuntime, page]);

  const pageStatus = (configured: boolean, label: string) => {
    if (statusQuery.isLoading) {
      return (
        <Loader2
          className="absolute top-1 right-1 size-3 animate-spin text-muted-foreground sm:static sm:ml-auto sm:size-3.5"
          aria-hidden
        />
      );
    }
    if (configured) {
      return (
        <span
          className="absolute top-1 right-1 size-2 shrink-0 rounded-full bg-emerald-400 sm:static sm:ml-auto"
          aria-label={t("settings.statusConfigured", { page: label })}
          title={t("settings.statusConfigured", { page: label })}
        />
      );
    }
    return (
      <AlertTriangle
        className="absolute top-1 right-1 size-3.5 shrink-0 text-amber-400 sm:static sm:ml-auto sm:size-4"
        aria-label={t("settings.statusNotConfigured", { page: label })}
      />
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton
        className="flex h-[min(82vh,760px)] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden rounded-lg border border-border bg-black p-0 ring-0 sm:max-w-[1120px]"
      >
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle>{t("settings.title")}</DialogTitle>
        </DialogHeader>

        <div className="flex min-h-0 flex-1">
          <nav
            aria-label={t("settings.navigationLabel")}
            className="flex w-14 shrink-0 flex-col gap-1 border-r border-border px-2 py-4 sm:w-44 sm:px-3"
          >
            {ceRuntime ? (
              <>
                <button
                  type="button"
                  aria-current={page === "models" ? "page" : undefined}
                  onClick={() => setPage("models")}
                  className={cn(
                    "relative flex h-10 items-center justify-center gap-2 rounded-md px-2 text-sm font-medium transition-colors sm:justify-start sm:px-3",
                    page === "models"
                      ? "bg-white/[0.09] text-foreground"
                      : "text-muted-foreground hover:bg-white/[0.05] hover:text-foreground",
                  )}
                >
                  <Cpu className="size-4" aria-hidden />
                  <span className="hidden sm:inline">{t("settings.pages.models")}</span>
                  {pageStatus(modelConfigured, t("settings.pages.models"))}
                </button>
                <button
                  type="button"
                  aria-current={page === "storage" ? "page" : undefined}
                  onClick={() => setPage("storage")}
                  className={cn(
                    "relative flex h-10 items-center justify-center gap-2 rounded-md px-2 text-sm font-medium transition-colors sm:justify-start sm:px-3",
                    page === "storage"
                      ? "bg-white/[0.09] text-foreground"
                      : "text-muted-foreground hover:bg-white/[0.05] hover:text-foreground",
                  )}
                >
                  <HardDrive className="size-4" aria-hidden />
                  <span className="hidden sm:inline">{t("settings.pages.storage")}</span>
                  {pageStatus(mediaStorageConfigured, t("settings.pages.storage"))}
                </button>
              </>
            ) : null}
            <button
              type="button"
              aria-current={page === "freezone-skills" || page === "freezone-recipes" ? "page" : undefined}
              onClick={() => setPage("freezone-skills")}
              className={cn(
                "relative flex h-10 items-center justify-center gap-2 rounded-md px-2 text-sm font-medium transition-colors sm:justify-start sm:px-3",
                page === "freezone-skills" || page === "freezone-recipes"
                  ? "bg-white/[0.09] text-foreground"
                  : "text-muted-foreground hover:bg-white/[0.05] hover:text-foreground",
              )}
            >
              <Package className="size-4" aria-hidden />
              <span className="hidden sm:inline">{t("settings.pages.freezoneSkills")}</span>
            </button>
          </nav>

          {page === "models" ? (
            <div className="min-w-0 flex-1">
              <ScrollArea className="h-full [&_[data-slot=scroll-area-scrollbar]]:!w-1 [&_[data-slot=scroll-area-scrollbar]]:!border-l-0 [&_[data-slot=scroll-area-scrollbar]]:!p-0">
                <ModelConfigSection open={open && page === "models"} />
                {SHOW_CODEX_BRIDGE && <CodexBridgeSection />}
              </ScrollArea>
            </div>
          ) : page === "storage" ? (
            <div className="min-w-0 flex-1">
              <ScrollArea className="h-full [&_[data-slot=scroll-area-scrollbar]]:!w-1 [&_[data-slot=scroll-area-scrollbar]]:!border-l-0 [&_[data-slot=scroll-area-scrollbar]]:!p-0">
                <MediaStorageSection />
              </ScrollArea>
            </div>
          ) : (
            <div className="min-w-0 flex-1">
              <ScrollArea className="h-full [&_[data-slot=scroll-area-scrollbar]]:!w-1 [&_[data-slot=scroll-area-scrollbar]]:!border-l-0 [&_[data-slot=scroll-area-scrollbar]]:!p-0">
                <FreezoneSkillRecipeSettings
                  kind={page === "freezone-skills" ? "skills" : "recipes"}
                  onBackToSkills={() => setPage("freezone-skills")}
                  onOpenRecipes={() => setPage("freezone-recipes")}
                  open={open && (page === "freezone-skills" || page === "freezone-recipes")}
                />
              </ScrollArea>
            </div>
          )}
        </div>

        <div className="flex justify-end border-t border-border px-5 py-3.5">
          <DialogClose render={<Button variant="outline" size="sm" />}>
            {t("settings.close")}
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const GATEWAY_MODES: GatewayMode[] = ["official", "custom", "hybrid"];

const DEFAULT_CUSTOM_NEWAPI_URL = "http://127.0.0.1:3000";

async function getRequestErrorMessage(
  error: unknown,
  fallback: string,
): Promise<string> {
  const response = (error as { response?: Response } | null)?.response;
  if (response) {
    const body = await response
      .clone()
      .json()
      .catch(() => null);
    if (body && typeof body === "object") {
      const data = body as {
        detail?: unknown;
        error?: unknown;
        message?: unknown;
      };
      for (const value of [data.detail, data.error, data.message]) {
        if (typeof value === "string" && value.trim()) return value.trim();
      }
    }
    const text = await response
      .clone()
      .text()
      .catch(() => "");
    if (text.trim()) return text.trim();
  }
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" && message.trim()
    ? message.trim()
    : fallback;
}

function getResponseErrorMessage(response: unknown, fallback: string): string {
  if (response && typeof response === "object") {
    const data = response as {
      detail?: unknown;
      error?: unknown;
      message?: unknown;
    };
    for (const value of [data.detail, data.error, data.message]) {
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    const payload = (data as { data?: unknown }).data;
    if (payload && typeof payload === "object") {
      const result = (payload as { result?: unknown }).result;
      if (result && typeof result === "object") {
        const error = (result as { error?: unknown }).error;
        if (typeof error === "string" && error.trim()) return error.trim();
      }
      const results = (payload as { results?: unknown }).results;
      if (Array.isArray(results)) {
        const failed = results.find(
          (item) =>
            item &&
            typeof item === "object" &&
            typeof (item as { error?: unknown }).error === "string" &&
            Boolean(((item as { error?: string }).error ?? "").trim()),
        ) as { error?: unknown } | undefined;
        if (typeof failed?.error === "string" && failed.error.trim()) {
          return failed.error.trim();
        }
      }
    }
    if (Array.isArray(data.detail)) {
      const first = data.detail.find(
        (item) => item && typeof item === "object",
      ) as { msg?: unknown } | undefined;
      if (typeof first?.msg === "string" && first.msg.trim())
        return first.msg.trim();
    }
  }
  return fallback;
}

function ModelConfigSection({ open }: { open: boolean }) {
  const { t } = useTranslation();
  const configQuery = useModelGatewayConfig(open);
  const config = configQuery.data?.data;
  const loading = configQuery.isLoading;
  const enableOfficialMode = useEnableOfficial();
  const enableCustomMode = useEnableCustom();
  const enableHybridMode = useEnableHybrid();
  const modelGatewayMissing = config
    ? !config.effective.configured || !config.llmEffective.configured
    : false;

  const [mode, setMode] = useState<GatewayMode>("official");
  const modeChosenByUser = useRef(false);
  const [customLlmMode, setCustomLlmMode] =
    useState<CustomLlmMode>("relayclaw_brainclaw");
  const updateCustomLlmMode = useSetCustomLlmMode();
  // 配置加载后，把激活的 tab 同步到服务端当前 mode。
  const serverMode = config?.mode;
  useEffect(() => {
    if (serverMode && !modeChosenByUser.current) {
      setMode((current) => (current === serverMode ? current : serverMode));
    }
  }, [serverMode]);
  useEffect(() => {
    if (config?.custom.llmMode) {
      setCustomLlmMode(config.custom.llmMode);
    }
  }, [config?.custom.llmMode]);

  const handleCustomLlmModeChange = async (value: string) => {
    const nextMode = value as CustomLlmMode;
    const previousMode = customLlmMode;
    setCustomLlmMode(nextMode);
    if (nextMode !== "advanced") return;
    try {
      const response = await updateCustomLlmMode.mutateAsync(nextMode);
      if (!response.ok) {
        setCustomLlmMode(previousMode);
        toast.error(getResponseErrorMessage(response, t("settings.modelConfig.requestFailed")));
        return;
      }
      toast.success(t("settings.modelConfig.brainclaw.advancedEnabled"));
    } catch (error) {
      setCustomLlmMode(previousMode);
      toast.error(await getRequestErrorMessage(error, t("settings.modelConfig.requestFailed")));
    }
  };

  // CE 运行环境提供本地 NewAPI 管理地址；初始化与下方模型映射共用该地址。
  const [customBaseUrl, setCustomBaseUrl] = useState(DEFAULT_CUSTOM_NEWAPI_URL);
  const seededCustomBaseUrl =
    config?.custom?.adminBaseUrl ||
    config?.provisioner?.adminBaseUrl ||
    config?.custom?.baseUrl ||
    "";
  useEffect(() => {
    if (seededCustomBaseUrl) {
      setCustomBaseUrl((current) =>
        current === seededCustomBaseUrl ? current : seededCustomBaseUrl,
      );
    }
  }, [seededCustomBaseUrl]);

  // CE owns one local SQLite-backed NewAPI instance. Database paths and the
  // root username are deployment details, not user-editable model settings.
  const customDatabase: NewApiDatabaseConfigInput | undefined = undefined;
  const selectedModeConfigured =
    mode === "official"
      ? Boolean(config?.official?.configured)
      : mode === "custom"
        ? Boolean(config?.custom?.configured)
        : Boolean(config?.official?.configured && config?.custom?.configured);
  const activatingMode =
    enableOfficialMode.isPending ||
    enableCustomMode.isPending ||
    enableHybridMode.isPending;

  const handleActivateMode = async () => {
    const mutation =
      mode === "official"
        ? enableOfficialMode
        : mode === "custom"
          ? enableCustomMode
          : enableHybridMode;
    try {
      const response = await mutation.mutateAsync();
      if (!response.ok) {
        toast.error(
          getResponseErrorMessage(
            response,
            t("settings.modelConfig.requestFailed"),
          ),
        );
        return;
      }
      toast.success(
        t("settings.modelConfig.modeActivated", {
          mode: t(`settings.modelConfig.modes.${mode}`),
        }),
      );
    } catch (error) {
      toast.error(
        await getRequestErrorMessage(
          error,
          t("settings.modelConfig.requestFailed"),
        ),
      );
    }
  };

  return (
    <section className="px-5 py-5">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "size-1.5 rounded-full",
            modelGatewayMissing ? "bg-amber-400" : "bg-emerald-400",
          )}
        />
        <h3 className="font-heading text-sm font-medium text-foreground">
          {t("settings.modelConfig.title")}
        </h3>
        {modelGatewayMissing ? (
          <AlertTriangle
            className="size-3.5 text-amber-400"
            aria-label={t("settings.modelConfig.gatewayWarningIconLabel")}
          />
        ) : null}
        {config ? (
          <span className="ml-1 rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {t("settings.modelConfig.effectiveBadge", {
              channel: t(
                `settings.modelConfig.modes.${config.effective.source}`,
                {
                  defaultValue: config.effective.source,
                },
              ),
            })}
          </span>
        ) : null}
        <a
          href={MODEL_CONFIGURATION_GUIDE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          {t("settings.modelConfig.guide")}
          <ExternalLink className="size-3" aria-hidden />
        </a>
      </div>

      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        {t("settings.modelConfig.description")}
      </p>
      {modelGatewayMissing ? (
        <div className="mt-3 flex gap-2 rounded-md border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-100">
          <AlertTriangle
            className="mt-0.5 size-3.5 shrink-0 text-amber-300"
            aria-hidden
          />
          <p>{t("settings.modelConfig.gatewayNotConfiguredImpact")}</p>
        </div>
      ) : null}

      <Tabs
        className="mt-4"
        value={mode}
        onValueChange={(value) => {
          const nextMode = value as GatewayMode;
          modeChosenByUser.current = true;
          setMode(nextMode);
        }}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <TabsList>
            {GATEWAY_MODES.map((m) => (
              <TabsTrigger key={m} value={m}>
                {t(`settings.modelConfig.modes.${m}`)}
              </TabsTrigger>
            ))}
          </TabsList>
          {mode !== serverMode ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleActivateMode}
              disabled={!selectedModeConfigured || activatingMode}
              title={
                selectedModeConfigured
                  ? t("settings.modelConfig.activateMode")
                  : t("settings.modelConfig.configureBeforeActivate")
              }
            >
              {activatingMode ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : null}
              {t("settings.modelConfig.activateMode")}
            </Button>
          ) : null}
        </div>
      </Tabs>

      <div className="mt-4">
        {mode === "official" || mode === "hybrid" ? (
          <OfficialGatewayPanel
            config={config}
            loading={loading}
            activateHybrid={mode === "hybrid"}
          />
        ) : null}
      </div>

      {/* 功能模型映射仅在自定义渠道展示；官方渠道不需要。 */}
      {mode === "custom" || mode === "hybrid" ? (
        <>
          <CustomGatewayPanel
            config={config}
            loading={loading}
            baseUrl={customBaseUrl}
            activateHybrid={mode === "hybrid"}
          />
          {mode === "custom" ? (
            <>
              <QuickLocalNewApiSetup
                config={config}
                loading={loading}
                newApiBaseUrl={customBaseUrl}
                database={customDatabase}
              />
              <div className="mt-5">
                <Tabs
                  value={customLlmMode}
                  onValueChange={handleCustomLlmModeChange}
                >
                  <TabsList>
                    <TabsTrigger value="relayclaw_brainclaw">
                      {t("settings.modelConfig.brainclaw.tab")}
                    </TabsTrigger>
                    <TabsTrigger value="advanced">
                      {t("settings.modelConfig.brainclaw.advancedTab")}
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              </div>
              {customLlmMode === "relayclaw_brainclaw" ? (
                <>
                  <BrainClawGatewayPanel config={config} loading={loading} />
                  <FeatureModelsBlock
                    showAdvancedLlm={false}
                    newApiBaseUrl={customBaseUrl}
                    database={customDatabase}
                    channelTypesEnabled={Boolean(
                      config?.custom?.configured &&
                      config?.provisioner?.database?.available,
                    )}
                    savedProviderChannels={
                      config?.provisioner?.providerChannels ?? []
                    }
                    savedEmbeddingModel={config?.provisioner?.embeddingModel}
                    savedMediaModels={config?.provisioner?.mediaModels ?? {}}
                  />
                </>
              ) : null}
            </>
          ) : null}
          {mode === "hybrid" ? (
            <details className="mt-5 rounded-md border border-border/70">
              <summary className="cursor-pointer px-3 py-3 text-xs font-medium text-foreground">
                {t("settings.modelConfig.quick.comfyConfig")}
              </summary>
              <div className="border-t border-border/70 px-3 pb-4">
                <FeatureModelsBlock
                  newApiBaseUrl={customBaseUrl}
                  database={customDatabase}
                  channelTypesEnabled={Boolean(
                    config?.custom?.configured &&
                    config?.provisioner?.database?.available,
                  )}
                  savedProviderChannels={
                    config?.provisioner?.providerChannels ?? []
                  }
                  savedEmbeddingModel={config?.provisioner?.embeddingModel}
                  savedMediaModels={config?.provisioner?.mediaModels ?? {}}
                  defaultComfyWorkflows={HYBRID_COMFYUI_WORKFLOWS}
                  mediaOnly
                  comfyOnly
                />
              </div>
            </details>
          ) : null}
          {mode === "custom" && customLlmMode === "advanced" ? (
            <details className="mt-5 rounded-md border border-border/70">
              <summary className="cursor-pointer px-3 py-3 text-xs font-medium text-foreground">
                {t("settings.modelConfig.quick.advanced")}
              </summary>
              <div className="border-t border-border/70 px-3 pb-4">
                <FeatureModelsBlock
                  newApiBaseUrl={customBaseUrl}
                  database={customDatabase}
                  channelTypesEnabled={Boolean(
                    config?.custom?.configured &&
                    config?.provisioner?.database?.available,
                  )}
                  savedProviderChannels={
                    config?.provisioner?.providerChannels ?? []
                  }
                  savedEmbeddingModel={config?.provisioner?.embeddingModel}
                  savedMediaModels={config?.provisioner?.mediaModels ?? {}}
                />
              </div>
            </details>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function OfficialGatewayPanel({
  config,
  loading,
  activateHybrid = false,
}: {
  config: ModelGatewayConfig | undefined;
  loading: boolean;
  activateHybrid?: boolean;
}) {
  const { t } = useTranslation();
  const official = config?.official;
  const enableOfficial = useEnableOfficial();
  const enableHybrid = useEnableHybrid();
  const saveOfficial = useSaveOfficialConfig();
  const mediaCatalogQuery = useOfficialMediaCatalogStatus();
  const saveMediaCatalogPreferences = useSaveOfficialMediaCatalogPreferences();
  const checkMediaCatalog = useCheckOfficialMediaCatalog();
  const automaticCatalogCheckStarted = useRef(false);

  const [apiKey, setApiKey] = useState("");
  const [revealKey, setRevealKey] = useState(false);
  const apiKeyInputRef = useRef<HTMLInputElement>(null);
  const savedApiKeyPreview = official?.configured ? official.apiKeyPreview : "";
  const mediaCatalog = mediaCatalogQuery.data?.data;

  const runMediaCatalogCheck = async (manual: boolean) => {
    try {
      const response = await checkMediaCatalog.mutateAsync();
      if (!response.ok) {
        if (manual) {
          toast.error(
            getResponseErrorMessage(
              response,
              t("settings.modelConfig.official.mediaCatalogCheckFailed"),
            ),
          );
        }
        return;
      }
      if (manual) {
        toast.success(
          t(
            response.data.updated
              ? "settings.modelConfig.official.mediaCatalogUpdated"
              : "settings.modelConfig.official.mediaCatalogUpToDate",
          ),
        );
      }
    } catch (error) {
      if (manual) {
        toast.error(
          await getRequestErrorMessage(
            error,
            t("settings.modelConfig.official.mediaCatalogCheckFailed"),
          ),
        );
      }
    }
  };

  useEffect(() => {
    if (
      automaticCatalogCheckStarted.current ||
      !mediaCatalog?.autoUpdate ||
      checkMediaCatalog.isPending
    )
      return;
    automaticCatalogCheckStarted.current = true;
    void runMediaCatalogCheck(false);
  }, [mediaCatalog?.autoUpdate, checkMediaCatalog.isPending]);

  const handleMediaCatalogAutoUpdate = async () => {
    const next = !mediaCatalog?.autoUpdate;
    try {
      const response = await saveMediaCatalogPreferences.mutateAsync(next);
      if (!response.ok) {
        toast.error(
          getResponseErrorMessage(
            response,
            t("settings.modelConfig.requestFailed"),
          ),
        );
      }
    } catch (error) {
      toast.error(
        await getRequestErrorMessage(
          error,
          t("settings.modelConfig.requestFailed"),
        ),
      );
    }
  };

  const handleSave = async () => {
    // Password managers may update the DOM without firing React's onChange.
    const trimmedApiKey = (
      apiKey ||
      apiKeyInputRef.current?.value ||
      ""
    ).trim();
    try {
      if (!trimmedApiKey) {
        if (!official?.configured) {
          toast.error(t("settings.modelConfig.official.missingFields"));
          return;
        }
        const response = await (
          activateHybrid && config?.custom?.configured
            ? enableHybrid
            : enableOfficial
        ).mutateAsync();
        if (!response.ok) {
          toast.error(
            getResponseErrorMessage(
              response,
              t("settings.modelConfig.requestFailed"),
            ),
          );
          return;
        }
        toast.success(t("settings.modelConfig.official.saved"));
        return;
      }
      const response = await saveOfficial.mutateAsync({
        newApiApiKey: trimmedApiKey,
      });
      if (!response.ok) {
        toast.error(
          getResponseErrorMessage(
            response,
            t("settings.modelConfig.requestFailed"),
          ),
        );
        return;
      }
      if (activateHybrid && config?.custom?.configured) {
        const hybridResponse = await enableHybrid.mutateAsync();
        if (!hybridResponse.ok) {
          toast.error(
            getResponseErrorMessage(
              hybridResponse,
              t("settings.modelConfig.requestFailed"),
            ),
          );
          return;
        }
      }
      setApiKey("");
      setRevealKey(false);
      toast.success(t("settings.modelConfig.official.saved"));
    } catch (error) {
      toast.error(
        await getRequestErrorMessage(
          error,
          t("settings.modelConfig.requestFailed"),
        ),
      );
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t("settings.modelConfig.official.description")}{" "}
        <a
          href="https://relayclaw.cdnfg.com"
          target="_blank"
          rel="noreferrer"
          className="text-primary underline-offset-4 hover:underline"
        >
          {t("settings.modelConfig.official.registerLink")}
        </a>
      </p>

      <div className="rounded-md border border-border/70 px-3 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-foreground">
              {t("settings.modelConfig.official.mediaCatalogTitle")}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {mediaCatalog
                ? t("settings.modelConfig.official.mediaCatalogStatus", {
                    version: mediaCatalog.catalogVersion,
                    count: mediaCatalog.modelCount,
                    source: t(
                      `settings.modelConfig.official.mediaCatalogSources.${mediaCatalog.source}`,
                    ),
                  })
                : t("settings.modelConfig.loading")}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void runMediaCatalogCheck(true)}
            disabled={
              mediaCatalogQuery.isLoading || checkMediaCatalog.isPending
            }
          >
            <RotateCw
              className={cn(
                "size-3.5",
                checkMediaCatalog.isPending && "animate-spin",
              )}
            />
            {t("settings.modelConfig.official.mediaCatalogCheckNow")}
          </Button>
        </div>
        <div className="mt-3 flex items-center justify-between gap-3 border-t border-border/60 pt-3">
          <div>
            <Label className="text-xs font-normal text-foreground">
              {t("settings.modelConfig.official.mediaCatalogAutoUpdate")}
            </Label>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              {t("settings.modelConfig.official.mediaCatalogAutoUpdateHint")}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={mediaCatalog?.autoUpdate ?? false}
            aria-label={t(
              "settings.modelConfig.official.mediaCatalogAutoUpdate",
            )}
            disabled={!mediaCatalog || saveMediaCatalogPreferences.isPending}
            onClick={() => void handleMediaCatalogAutoUpdate()}
            className={cn(
              "relative h-5 w-9 shrink-0 rounded-full border transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
              mediaCatalog?.autoUpdate
                ? "border-primary bg-primary"
                : "border-input bg-muted",
            )}
          >
            <span
              className={cn(
                "absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow-sm transition-transform",
                mediaCatalog?.autoUpdate ? "translate-x-4" : "translate-x-0",
              )}
            />
          </button>
        </div>
      </div>

      <div className="space-y-2.5">
        <div className="grid grid-cols-[120px_1fr] items-center gap-3">
          <Label className="justify-start text-[11px] font-normal tracking-wide text-muted-foreground uppercase">
            {t("settings.modelConfig.fields.apiKey")}
          </Label>
          <div className="relative">
            <Input
              ref={apiKeyInputRef}
              name="relayclaw-official-api-key"
              autoComplete="new-password"
              data-1p-ignore="true"
              data-lpignore="true"
              type={revealKey ? "text" : "password"}
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                if (!e.target.value) setRevealKey(false);
              }}
              placeholder={
                savedApiKeyPreview
                  ? t("settings.secretSavedPlaceholder", {
                      preview: savedApiKeyPreview,
                    })
                  : "sk-..."
              }
              autoCapitalize="none"
              spellCheck={false}
              className={cn(
                "h-9 rounded-md border-input/80 focus-visible:border-ring/70 focus-visible:ring-1 focus-visible:ring-ring/30",
                apiKey ? "pr-9" : savedApiKeyPreview ? "pr-16" : "",
              )}
            />
            {apiKey ? (
              <button
                type="button"
                onClick={() => setRevealKey((r) => !r)}
                aria-label={
                  revealKey
                    ? t("settings.mediaStorage.hideSecret")
                    : t("settings.mediaStorage.showSecret")
                }
                className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
              >
                {revealKey ? (
                  <EyeOff className="size-4" />
                ) : (
                  <Eye className="size-4" />
                )}
              </button>
            ) : savedApiKeyPreview ? (
              <span className="absolute top-1/2 right-2 -translate-y-1/2 rounded bg-emerald-400/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">
                {t("settings.secretSavedBadge")}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          onClick={handleSave}
          disabled={
            loading ||
            saveOfficial.isPending ||
            enableOfficial.isPending ||
            enableHybrid.isPending
          }
        >
          {saveOfficial.isPending ||
          enableOfficial.isPending ||
          enableHybrid.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : null}
          {t("settings.modelConfig.official.save")}
        </Button>
      </div>
    </div>
  );
}

function BrainClawGatewayPanel({
  config,
  loading,
}: {
  config: ModelGatewayConfig | undefined;
  loading: boolean;
}) {
  const { t } = useTranslation();
  const saveBrainClaw = useSaveBrainClawConfig();
  const enableBrainClaw = useEnableBrainClaw();
  const savedBrainClaw = config?.brainclaw;
  const savedBaseUrl =
    savedBrainClaw?.baseUrl ||
    (config?.llmEffective.brainclaw ? config.llmEffective.baseUrl : "") ||
    config?.official.baseUrl ||
    "";
  const [baseUrl, setBaseUrl] = useState(savedBaseUrl);
  const [apiKey, setApiKey] = useState("");
  const [revealKey, setRevealKey] = useState(false);
  const savedApiKeyPreview =
    savedBrainClaw?.apiKeyPreview ||
    (config?.llmEffective.brainclaw ? config.llmEffective.apiKeyPreview : "") ||
    config?.official.apiKeyPreview ||
    "";

  useEffect(() => {
    if (savedBaseUrl) {
      setBaseUrl((current) => (current === savedBaseUrl ? current : savedBaseUrl));
    }
  }, [savedBaseUrl]);

  const handleSave = async () => {
    const trimmedApiKey = apiKey.trim();
    const trimmedBaseUrl = baseUrl.trim();
    if (!trimmedBaseUrl) {
      toast.error(t("settings.modelConfig.brainclaw.missingEndpoint"));
      return;
    }
    try {
      const response = trimmedApiKey || trimmedBaseUrl !== savedBaseUrl
        ? await saveBrainClaw.mutateAsync({
            newApiBaseUrl: trimmedBaseUrl,
            ...(trimmedApiKey ? { newApiApiKey: trimmedApiKey } : {}),
          })
        : await enableBrainClaw.mutateAsync();
      if (!response.ok) {
        toast.error(getResponseErrorMessage(response, t("settings.modelConfig.requestFailed")));
        return;
      }
      setApiKey("");
      setRevealKey(false);
      toast.success(t("settings.modelConfig.brainclaw.enabled"));
    } catch (error) {
      toast.error(await getRequestErrorMessage(error, t("settings.modelConfig.requestFailed")));
    }
  };

  return (
    <div className="mt-4 rounded-md border border-primary/30 bg-primary/[0.04] px-3 py-3">
      <h4 className="text-xs font-medium text-foreground">
        {t("settings.modelConfig.brainclaw.title")}
      </h4>
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
        {t("settings.modelConfig.brainclaw.description")}
      </p>

      <div className="mt-3 space-y-2.5">
        <div className="grid grid-cols-[120px_1fr] items-center gap-3">
          <Label className="justify-start text-[11px] font-normal tracking-wide text-muted-foreground uppercase">
            {t("settings.modelConfig.fields.gatewayBaseUrl")}
          </Label>
          <Input
            name="brainclaw-newapi-base-url"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="http://127.0.0.1:3000/v1"
            autoCapitalize="none"
            spellCheck={false}
            className="h-9"
          />
        </div>
        <div className="grid grid-cols-[120px_1fr] items-center gap-3">
          <Label className="justify-start text-[11px] font-normal tracking-wide text-muted-foreground uppercase">
            {t("settings.modelConfig.fields.apiKey")}
          </Label>
          <div className="relative">
            <Input
              name="relayclaw-brainclaw-api-key"
              autoComplete="new-password"
              data-1p-ignore="true"
              data-lpignore="true"
              type={revealKey ? "text" : "password"}
              value={apiKey}
              onChange={(event) => {
                setApiKey(event.target.value);
                if (!event.target.value) setRevealKey(false);
              }}
              placeholder={
                savedApiKeyPreview
                  ? t("settings.secretSavedPlaceholder", { preview: savedApiKeyPreview })
                  : "sk-..."
              }
              autoCapitalize="none"
              spellCheck={false}
              className={cn("h-9", apiKey ? "pr-9" : savedApiKeyPreview ? "pr-16" : "")}
            />
            {apiKey ? (
              <button
                type="button"
                onClick={() => setRevealKey((value) => !value)}
                aria-label={
                  revealKey
                    ? t("settings.mediaStorage.hideSecret")
                    : t("settings.mediaStorage.showSecret")
                }
                className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
              >
                {revealKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            ) : savedApiKeyPreview ? (
              <span className="absolute top-1/2 right-2 -translate-y-1/2 rounded bg-emerald-400/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">
                {t("settings.secretSavedBadge")}
              </span>
            ) : null}
          </div>
        </div>
        <div className="grid grid-cols-[120px_1fr] items-center gap-3 text-[11px]">
          <span className="text-muted-foreground">{t("settings.modelConfig.brainclaw.model")}</span>
          <code className="text-foreground">brainclaw</code>
        </div>
      </div>

      <div className="mt-3 flex justify-end">
        <Button
          type="button"
          size="sm"
          onClick={handleSave}
          disabled={
            loading ||
            saveBrainClaw.isPending ||
            enableBrainClaw.isPending ||
            !baseUrl.trim() ||
            (!apiKey.trim() && !savedApiKeyPreview)
          }
        >
          {saveBrainClaw.isPending || enableBrainClaw.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : null}
          {t("settings.modelConfig.brainclaw.save")}
        </Button>
      </div>
    </div>
  );
}

function CustomGatewayPanel({
  config,
  loading,
  baseUrl,
  activateHybrid = false,
}: {
  config: ModelGatewayConfig | undefined;
  loading: boolean;
  baseUrl: string;
  activateHybrid?: boolean;
}) {
  const { t } = useTranslation();
  const initCustom = useInitCustomNewApi();
  const enableHybrid = useEnableHybrid();
  const [setupPassword, setSetupPassword] = useState("");
  const [setupConfirmPassword, setSetupConfirmPassword] = useState("");
  const [initError, setInitError] = useState("");
  const [initNotice, setInitNotice] = useState("");

  const showInitError = (message: string) => {
    setInitError(message);
    setInitNotice("");
    toast.error(message);
  };

  const showInitResponseError = (message: string) => {
    const displayMessage =
      message.includes("setupUsername") ||
      message.includes("NewAPI is not initialized")
        ? t("settings.modelConfig.custom.setupRequired")
        : message;
    showInitError(displayMessage);
  };

  const handleInit = async () => {
    setInitError("");
    setInitNotice("");
    const trimmedSetupPassword = setupPassword.trim();
    const trimmedSetupConfirmPassword = setupConfirmPassword.trim();
    const hasSetupPassword = Boolean(
      trimmedSetupPassword || trimmedSetupConfirmPassword,
    );
    if (
      hasSetupPassword &&
      (!trimmedSetupPassword || !trimmedSetupConfirmPassword)
    ) {
      showInitError(t("settings.modelConfig.custom.setupPasswordIncomplete"));
      return;
    }
    if (hasSetupPassword && trimmedSetupPassword.length < 8) {
      showInitError(t("settings.modelConfig.custom.setupPasswordTooShort"));
      return;
    }
    if (
      hasSetupPassword &&
      trimmedSetupPassword !== trimmedSetupConfirmPassword
    ) {
      showInitError(t("settings.modelConfig.custom.setupPasswordMismatch"));
      return;
    }

    try {
      const response = await initCustom.mutateAsync({
        ...(baseUrl.trim() ? { newApiBaseUrl: baseUrl.trim() } : {}),
        ...(hasSetupPassword
          ? {
              setupUsername: "root",
              setupPassword: trimmedSetupPassword,
              setupConfirmPassword: trimmedSetupConfirmPassword,
            }
          : {}),
      });
      if (response.ok !== true) {
        showInitResponseError(
          getResponseErrorMessage(
            response,
            t("settings.modelConfig.requestFailed"),
          ),
        );
        return;
      }
      const passwordIgnored =
        hasSetupPassword &&
        response.data.newApiSetup?.alreadyInitialized === true;
      setSetupPassword("");
      setSetupConfirmPassword("");
      if (passwordIgnored) {
        setInitNotice(
          t(
            "settings.modelConfig.custom.setupAlreadyInitializedPasswordIgnored",
          ),
        );
      }
      if (activateHybrid && config?.official?.configured) {
        const hybridResponse = await enableHybrid.mutateAsync();
        if (!hybridResponse.ok) {
          showInitResponseError(
            getResponseErrorMessage(
              hybridResponse,
              t("settings.modelConfig.requestFailed"),
            ),
          );
          return;
        }
      }
      toast.success(t("settings.modelConfig.custom.initialized"));
    } catch (error) {
      const message = await getRequestErrorMessage(
        error,
        t("settings.modelConfig.requestFailed"),
      );
      showInitResponseError(message);
    }
  };

  const databaseStatus = config?.provisioner?.database;
  const databaseReady = Boolean(databaseStatus?.available);
  const customConfigured = Boolean(config?.custom?.configured);

  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t("settings.modelConfig.custom.description")}
      </p>

      <div className="rounded-md border border-border/70 p-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            {t("settings.modelConfig.custom.localStatusTitle")}
          </p>
          <span
            className={cn(
              "text-[11px]",
              customConfigured ? "text-emerald-400" : "text-amber-300",
            )}
          >
            {customConfigured
              ? t("settings.modelConfig.custom.localReady")
              : t("settings.modelConfig.custom.localNeedsInit")}
          </span>
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
          {databaseReady
            ? t("settings.modelConfig.custom.sqliteReady")
            : t("settings.modelConfig.custom.sqliteWaiting")}
        </p>
      </div>

      {!customConfigured ? (
        <div className="rounded-md border border-border/70 p-3">
          <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            {t("settings.modelConfig.custom.setupAdminTitle")}
          </p>
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
            {t("settings.modelConfig.custom.setupAdminDescription")}
          </p>
          <div className="mt-3 space-y-2.5">
            <FieldRow
              secret
              name="newapi-setup-password"
              autoComplete="new-password"
              label={t("settings.modelConfig.custom.setupPassword")}
              value={setupPassword}
              onChange={setSetupPassword}
              placeholder={t(
                "settings.modelConfig.custom.setupPasswordPlaceholder",
              )}
            />
            <FieldRow
              secret
              name="newapi-setup-password-confirmation"
              autoComplete="new-password"
              label={t("settings.modelConfig.custom.setupConfirmPassword")}
              value={setupConfirmPassword}
              onChange={setSetupConfirmPassword}
              placeholder={t(
                "settings.modelConfig.custom.setupConfirmPasswordPlaceholder",
              )}
            />
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            {t("settings.modelConfig.custom.setupPasswordOnlyOnce")}
          </p>
        </div>
      ) : null}

      {initError ? (
        <p
          role="alert"
          aria-live="polite"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] leading-relaxed text-destructive"
        >
          {initError}
        </p>
      ) : null}
      {!initError && initNotice ? (
        <p
          role="status"
          aria-live="polite"
          className="rounded-md border border-amber-400/35 bg-amber-400/10 px-3 py-2 text-[11px] leading-relaxed text-amber-200"
        >
          {initNotice}
        </p>
      ) : null}

      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          onClick={handleInit}
          disabled={loading || initCustom.isPending}
        >
          {initCustom.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : null}
          {t(
            customConfigured
              ? "settings.modelConfig.custom.repair"
              : "settings.modelConfig.custom.init",
          )}
        </Button>
      </div>
    </div>
  );
}

// 功能模型映射每行的三列栅格：功能 | 供应商 | 模型名称。表头与行共用同一模板以对齐。
const FEATURE_ROW_GRID =
  "grid grid-cols-[minmax(0,1fr)_150px_minmax(0,1fr)] items-center gap-3";

function splitFeatureModelGroups(
  groups: readonly FeatureModelGroup[],
  predicate: (feature: FeatureModelDef) => boolean,
): FeatureModelGroup[] {
  return groups
    .map((group) => ({
      ...group,
      features: group.features.filter(predicate),
    }))
    .filter((group) => group.features.length > 0);
}

const MEDIA_MODEL_ROWS: readonly {
  model: string;
  kind: "image" | "video" | "audio";
  officialOnly?: boolean;
}[] = [
  { model: "LingShan-G2", kind: "image" },
  { model: "LingShan-NB-2", kind: "image" },
  { model: "seedance-1.0-pro-fast", kind: "video" },
  { model: "seedance-1.0-pro", kind: "video" },
  { model: "seedance-1.5-pro", kind: "video" },
  { model: "seedance-2.0", kind: "video" },
  { model: "seedance-2.0-fast", kind: "video" },
  { model: "seedance-2.0-mini", kind: "video" },
  { model: "happyhorse-1.0", kind: "video" },
  { model: "index-tts-2", kind: "audio" },
  { model: "LingShan-MU-11", kind: "audio" },
];

const MAINLINE_MEDIA_MODEL_IDS = new Set(
  MEDIA_MODEL_ROWS.filter((row) => !row.officialOnly).map((row) => row.model),
);

const MEDIA_ROW_GRID =
  "grid grid-cols-[70px_minmax(0,1fr)_130px_minmax(0,1fr)_80px] items-center gap-3";

const DEFAULT_EMBEDDING_DIMENSION = 1024;
const DEFAULT_EMBEDDING_BATCH_SIZE = 10;

interface QuickProfileChannel {
  id: string;
  provider: FeatureModelProvider;
  type?: number;
  baseUrl: string;
  priority?: number;
  settings?: Record<string, unknown>;
}

interface QuickProfileModel {
  channel: string;
  model: string;
  mediaType?: "image" | "video" | "audio";
  label?: string;
  enabled?: boolean;
  sortOrder?: number;
  config?: Record<string, unknown>;
}

interface QuickModelProfile {
  version: 2;
  name: string;
  channels: QuickProfileChannel[];
  featureModels: {
    text: QuickProfileModel;
    vision: QuickProfileModel;
    overrides: Record<string, QuickProfileModel>;
  };
  embedding: QuickProfileModel & { dimension: number; batchSize: number };
  mediaModels: Record<string, QuickProfileModel>;
}

function comfyNode(classType: string, inputs: Record<string, unknown>) {
  return { inputs, class_type: classType };
}

function minimaxH3Fl2vaWorkflow(firstFrame: boolean) {
  const generationInputs: Record<string, unknown> = {
    prompt: "",
    width: ["115", 0],
    height: ["115", 1],
    length: ["105:107", 1],
    clip: ["105:13", 0],
    vae: ["105:11", 0],
  };
  if (firstFrame) generationInputs.first_frame = ["114", 0];
  return {
    "92": comfyNode("SaveVideo", {
      filename_prefix: "video/MiniMax_H3",
      format: "auto",
      codec: "auto",
      video: ["105:91", 0],
    }),
    ...(firstFrame
      ? {
          "114": comfyNode("LoadImage", {
            image: "transparent_rgb_gaming_mouse.png",
          }),
          "119": comfyNode("ImageScaleToTotalPixels", {
            upscale_method: "nearest-exact",
            megapixels: 1,
            resolution_steps: 32,
          }),
          "120": comfyNode("GetImageSize", { image: ["119", 0] }),
        }
      : {}),
    "115": comfyNode("ResolutionSelector", {
      aspect_ratio: firstFrame ? "1:1 (Square)" : "16:9 (Widescreen)",
      megapixels: 0.4,
      multiple: 32,
    }),
    "105:11": comfyNode("VAELoader", {
      vae_name: "minimax_h3_video_vae_fp16.safetensors",
    }),
    "105:24": comfyNode("VAELoader", {
      vae_name: "minimax_h3_audio_vae_fp32.safetensors",
    }),
    "105:23": comfyNode("VAEDecodeAudio", {
      samples: ["105:14", 0],
      vae: ["105:24", 0],
    }),
    "105:10": comfyNode("VAEDecode", {
      samples: ["105:14", 0],
      vae: ["105:11", 0],
    }),
    "105:17": comfyNode("KSamplerSelect", { sampler_name: "res_multistep" }),
    "105:9": comfyNode("BasicScheduler", {
      scheduler: "simple",
      steps: 20,
      denoise: 1,
      model: ["105:6", 0],
    }),
    "105:14": comfyNode("SamplerCustomAdvanced", {
      noise: ["105:15", 0],
      guider: ["105:16", 0],
      sampler: ["105:17", 0],
      sigmas: ["105:9", 0],
      latent_image: ["105:104", 1],
    }),
    "105:16": comfyNode("BasicGuider", {
      model: ["105:6", 0],
      conditioning: ["105:104", 0],
    }),
    "105:6": comfyNode("UNETLoader", {
      unet_name: "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
      weight_dtype: "default",
    }),
    "105:13": comfyNode("CLIPLoader", {
      clip_name: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
      type: "minimax",
      device: "default",
    }),
    "105:15": comfyNode("RandomNoise", {
      noise_seed: firstFrame ? 168866841893410 : 556589502035082,
    }),
    "105:91": comfyNode("CreateVideo", {
      fps: 24,
      bit_depth: 8,
      images: ["105:10", 0],
      audio: ["105:23", 0],
    }),
    "105:104": comfyNode("MiniMaxH3ImageToVideo", generationInputs),
    "105:107": comfyNode("ComfyMathExpression", {
      expression:
        "max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17",
      "values.a": ["105:111", 0],
    }),
    "105:111": comfyNode("PrimitiveFloat", { value: 5 }),
  };
}

function minimaxH3ReferenceWorkflow() {
  return {
    "92": comfyNode("SaveVideo", {
      filename_prefix: "video/MiniMax_H3",
      format: "auto",
      codec: "auto",
      video: ["130", 0],
    }),
    "115": comfyNode("ResolutionSelector", {
      aspect_ratio: "16:9 (Widescreen)",
      megapixels: 0.4,
      multiple: 32,
    }),
    "119": comfyNode("VAELoader", {
      vae_name: "minimax_h3_video_vae_fp16.safetensors",
    }),
    "120": comfyNode("VAELoader", {
      vae_name: "minimax_h3_audio_vae_fp32.safetensors",
    }),
    "121": comfyNode("VAEDecodeAudio", {
      samples: ["125", 0],
      vae: ["120", 0],
    }),
    "122": comfyNode("VAEDecode", { samples: ["125", 0], vae: ["119", 0] }),
    "123": comfyNode("KSamplerSelect", { sampler_name: "res_multistep" }),
    "124": comfyNode("BasicScheduler", {
      scheduler: "simple",
      steps: 20,
      denoise: 1,
      model: ["127", 0],
    }),
    "125": comfyNode("SamplerCustomAdvanced", {
      noise: ["129", 0],
      guider: ["126", 0],
      sampler: ["123", 0],
      sigmas: ["124", 0],
      latent_image: ["136", 1],
    }),
    "126": comfyNode("BasicGuider", {
      model: ["127", 0],
      conditioning: ["136", 0],
    }),
    "127": comfyNode("UNETLoader", {
      unet_name: "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
      weight_dtype: "default",
    }),
    "128": comfyNode("CLIPLoader", {
      clip_name: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
      type: "minimax",
      device: "default",
    }),
    "129": comfyNode("RandomNoise", { noise_seed: 157368968253448 }),
    "130": comfyNode("CreateVideo", {
      fps: 24,
      bit_depth: 8,
      images: ["122", 0],
      audio: ["121", 0],
    }),
    "131": comfyNode("ComfyMathExpression", {
      expression:
        "max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17",
      "values.a": ["132", 0],
    }),
    "132": comfyNode("PrimitiveFloat", { value: 5 }),
    "136": comfyNode("MiniMaxH3ReferenceToVideo", {
      prompt: ["138", 0],
      width: ["115", 0],
      height: ["115", 1],
      length: ["131", 1],
      ref_image_size: "match",
      clip: ["128", 0],
      vae: ["119", 0],
      audio_vae: ["120", 0],
      "ref_images.ref_image_0": ["137", 0],
      "ref_images.ref_image_1": ["139", 0],
    }),
    "137": comfyNode("LoadImage", { image: "red_superboy_on_city_roof.png" }),
    "138": comfyNode("PrimitiveStringMultiline", { value: "" }),
    "139": comfyNode("LoadImage", { image: "mecha_dragon_lightning.png" }),
  };
}

const HYBRID_COMFYUI_WORKFLOWS = {
  model: "MiniMax-H3-local",
  workflows: {
    minimax_h3_t2v: minimaxH3Fl2vaWorkflow(false),
    minimax_h3_i2v: minimaxH3Fl2vaWorkflow(true),
    minimax_h3_r2v: minimaxH3ReferenceWorkflow(),
  },
};

type ChannelCapability =
  | "text"
  | "vision"
  | "embedding"
  | "rerank"
  | "image"
  | "video"
  | "audio";

const CUSTOM_PROVIDER_CHANNEL_TYPES: Readonly<Record<string, number>> = {
  fal_ai: 61,
  comfyui: 63,
};

function customProviderChannelType(provider: string): number | undefined {
  return CUSTOM_PROVIDER_CHANNEL_TYPES[provider];
}

export function providersSupportingCapability(
  configuredProviders: readonly FeatureModelProvider[],
  channelTypeByProvider: ReadonlyMap<string, NewApiChannelType>,
  capability: ChannelCapability,
  currentProvider?: FeatureModelProvider,
): FeatureModelProvider[] {
  const supported = configuredProviders.filter((provider) => {
    const channelType = channelTypeByProvider.get(provider);
    return !channelType || channelType.capabilities.includes(capability);
  });
  if (
    currentProvider &&
    configuredProviders.includes(currentProvider) &&
    !supported.includes(currentProvider)
  ) {
    return [currentProvider, ...supported];
  }
  return supported;
}

const RECOMMENDED_MEDIA_MODELS: Readonly<Record<string, QuickProfileModel>> = {
  "LingShan-G2": {
    channel: "openrouter",
    model: "openai/gpt-image-2",
    mediaType: "image",
  },
  "LingShan-NB-2": {
    channel: "openrouter",
    model: "google/gemini-3.1-flash-image",
    mediaType: "image",
  },
  "seedance-1.0-pro-fast": {
    channel: "volcengine",
    model: "seedance-1.0-pro-fast",
    mediaType: "video",
  },
  "seedance-1.0-pro": {
    channel: "volcengine",
    model: "doubao-seedance-1-0-pro-250528",
    mediaType: "video",
  },
  "seedance-1.5-pro": {
    channel: "volcengine",
    model: "doubao-seedance-1-5-pro-251215",
    mediaType: "video",
  },
  "seedance-2.0": {
    channel: "volcengine",
    model: "doubao-seedance-2-0-260128",
    mediaType: "video",
  },
  "seedance-2.0-fast": {
    channel: "volcengine",
    model: "doubao-seedance-2-0-fast-260128",
    mediaType: "video",
  },
  "seedance-2.0-mini": {
    channel: "volcengine",
    model: "doubao-seedance-2-0-mini-260615",
    mediaType: "video",
  },
  "happyhorse-1.0": {
    channel: "openrouter",
    model: "alibaba/happyhorse-1.0",
    mediaType: "video",
  },
  "index-tts-2": {
    channel: "openrouter",
    model: "openai/gpt-audio",
    mediaType: "audio",
  },
  "LingShan-MU-11": {
    channel: "openrouter",
    model: "openai/gpt-audio",
    mediaType: "audio",
  },
};

const RECOMMENDED_LOCAL_NEWAPI_PROFILE: QuickModelProfile = {
  version: 2,
  name: "OpenRouter+ VolCengine",
  channels: [
    {
      id: "openrouter",
      provider: "openrouter",
      baseUrl: "",
      priority: 0,
      settings: {},
    },
    {
      id: "volcengine",
      provider: "volcengine",
      baseUrl: "",
      priority: 0,
      settings: {},
    },
  ],
  featureModels: {
    text: { channel: "openrouter", model: "openai/gpt-5.6-luna" },
    vision: { channel: "openrouter", model: "openai/gpt-5.6-luna" },
    overrides: {},
  },
  embedding: {
    channel: "openrouter",
    model: "qwen/qwen3-embedding-8b",
    dimension: 1024,
    batchSize: 10,
  },
  mediaModels: Object.fromEntries(
    Object.entries(RECOMMENDED_MEDIA_MODELS).map(([model, mapping]) => [
      model,
      {
        ...mapping,
        label: model,
        enabled: true,
        sortOrder: 100,
        config:
          mapping.config ??
          (mapping.mediaType === "image" || mapping.mediaType === "video"
            ? {
                request: {
                  endpoint:
                    mapping.mediaType === "image"
                      ? "images/generations"
                      : "video/generations",
                  parameters: [],
                },
              }
            : {}),
      },
    ]),
  ),
};

type QuickProfileKind = "recommended" | "custom";

interface StoredQuickProfiles {
  version: 1;
  selected: QuickProfileKind;
  customProfileJson: string;
  appliedProfileJson: string;
}

const QUICK_PROFILES_STORAGE_KEY = "dramaclaw-ce-quick-model-profiles";
const RECOMMENDED_PROFILE_JSON = JSON.stringify(
  RECOMMENDED_LOCAL_NEWAPI_PROFILE,
  null,
  2,
);

function loadStoredQuickProfiles(): StoredQuickProfiles {
  const fallback: StoredQuickProfiles = {
    version: 1,
    selected: "recommended",
    customProfileJson: "",
    appliedProfileJson: "",
  };
  if (typeof window === "undefined") return fallback;
  try {
    const stored = JSON.parse(
      localStorage.getItem(QUICK_PROFILES_STORAGE_KEY) ?? "null",
    ) as Partial<StoredQuickProfiles> | null;
    if (!stored || stored.version !== 1) return fallback;
    return {
      version: 1,
      selected: stored.selected === "custom" ? "custom" : "recommended",
      customProfileJson:
        typeof stored.customProfileJson === "string"
          ? stored.customProfileJson
          : "",
      appliedProfileJson:
        typeof stored.appliedProfileJson === "string"
          ? stored.appliedProfileJson
          : "",
    };
  } catch {
    return fallback;
  }
}

function saveStoredQuickProfiles(
  value: Omit<StoredQuickProfiles, "version">,
): void {
  safeLocalStorageSet(
    QUICK_PROFILES_STORAGE_KEY,
    JSON.stringify({ version: 1, ...value } satisfies StoredQuickProfiles),
  );
}

function parseQuickModelProfile(value: string): QuickModelProfile {
  const profile = JSON.parse(value) as QuickModelProfile;
  if (profile.version !== 2) throw new Error("unsupported profile version");
  if (!Array.isArray(profile.channels) || profile.channels.length === 0) {
    throw new Error("channels must be a non-empty array");
  }
  const channelIds = new Set<string>();
  const providers = new Set<string>();
  for (const channel of profile.channels) {
    const id = channel.id?.trim();
    if (!id) throw new Error("channel.id is required");
    if (channelIds.has(id)) throw new Error(`duplicate channel id: ${id}`);
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(channel.provider)) {
      throw new Error(`unsupported provider: ${channel.provider}`);
    }
    if (
      channel.type !== undefined &&
      (!Number.isInteger(channel.type) || channel.type <= 0)
    ) {
      throw new Error(`invalid channel type: ${channel.provider}`);
    }
    if (channel.provider === "comfyui") {
      const workflows = readComfyUIWorkflows(channel.settings ?? {});
      const model = readComfyUIModelName(channel.settings ?? {});
      if (!channel.baseUrl?.trim())
        throw new Error("ComfyUI channel.baseUrl is required");
      if (!model) throw new Error("ComfyUI model name is required");
      if (Object.keys(workflows).length === 0)
        throw new Error("ComfyUI requires at least one workflow");
    }
    if (providers.has(channel.provider)) {
      throw new Error(
        `duplicate provider is not supported yet: ${channel.provider}`,
      );
    }
    channelIds.add(id);
    providers.add(channel.provider);
  }
  const validateModel = (item: QuickProfileModel | undefined, path: string) => {
    if (!item?.channel?.trim() || !channelIds.has(item.channel.trim())) {
      throw new Error(
        `${path}.channel does not reference a configured channel`,
      );
    }
    if (!item.model?.trim()) throw new Error(`${path}.model is required`);
  };
  validateModel(profile.featureModels?.text, "featureModels.text");
  validateModel(profile.featureModels?.vision, "featureModels.vision");
  for (const [featureId, item] of Object.entries(
    profile.featureModels?.overrides ?? {},
  )) {
    validateModel(item, `featureModels.overrides.${featureId}`);
  }
  validateModel(profile.embedding, "embedding");
  if (
    !Number.isInteger(profile.embedding.dimension) ||
    profile.embedding.dimension <= 0
  ) {
    throw new Error("embedding.dimension must be a positive integer");
  }
  if (
    !Number.isInteger(profile.embedding.batchSize) ||
    profile.embedding.batchSize <= 0
  ) {
    throw new Error("embedding.batchSize must be a positive integer");
  }
  if (!profile.mediaModels || typeof profile.mediaModels !== "object") {
    throw new Error("mediaModels must be an object");
  }
  for (const [model, item] of Object.entries(profile.mediaModels)) {
    validateModel(item, `mediaModels.${model}`);
  }
  return profile;
}

export function syncQuickProfileFromAdvancedSettings(
  profile: QuickModelProfile,
  settings: FeatureModelSettings,
): QuickModelProfile | null {
  const usableProviderChannels = Object.values(settings.providerChannels).filter((channel) => {
    if (channel.provider !== "comfyui") return true;
    if (!channel.baseUrl.trim()) return false;
    const comfySettings = normalizeProviderChannelSettings("comfyui", channel.settings);
    return (
      Boolean(readComfyUIModelName(comfySettings)) &&
      Object.keys(readComfyUIWorkflows(comfySettings)).length > 0
    );
  });
  if (usableProviderChannels.length === 0) return null;

  const previousChannelByProvider = new Map(
    profile.channels.map((channel) => [channel.provider, channel]),
  );
  const usedChannelIds = new Set<string>();
  const channels = usableProviderChannels.map((channel) => {
    const previous = previousChannelByProvider.get(channel.provider);
    let id = previous?.id || channel.provider;
    for (let suffix = 2; usedChannelIds.has(id); suffix += 1) id = `${channel.provider}-${suffix}`;
    usedChannelIds.add(id);
    return {
      id,
      provider: channel.provider,
      ...(previous?.type
        ? { type: previous.type }
        : customProviderChannelType(channel.provider)
          ? { type: customProviderChannelType(channel.provider) }
          : {}),
      baseUrl: channel.baseUrl,
      priority: channel.priority,
      settings: normalizeProviderChannelSettings(channel.provider, channel.settings),
    };
  });
  const channelIdByProvider = new Map(channels.map((channel) => [channel.provider, channel.id]));
  const activeChannelIds = new Set(channels.map((channel) => channel.id));
  const modelFromEntry = (entry: FeatureModelEntry | undefined): QuickProfileModel | null => {
    const channel = entry && channelIdByProvider.get(entry.provider);
    const model = entry?.model.trim() ?? "";
    return channel && model ? { channel, model } : null;
  };
  const firstFeatureModel = (requiresVision: boolean) => {
    for (const group of FEATURE_MODEL_GROUPS) {
      for (const feature of group.features) {
        if (Boolean(feature.requiresVision) !== requiresVision) continue;
        const selected = modelFromEntry(settings.featureModels[feature.id]);
        if (selected) return selected;
      }
    }
    return null;
  };
  const keepActiveModel = (item: QuickProfileModel) =>
    activeChannelIds.has(item.channel) && item.model.trim() ? item : null;
  const text = keepActiveModel(profile.featureModels.text) ?? firstFeatureModel(false);
  const vision = keepActiveModel(profile.featureModels.vision) ?? firstFeatureModel(true);
  if (!text || !vision) return null;

  const overrides: Record<string, QuickProfileModel> = {};
  for (const group of FEATURE_MODEL_GROUPS) {
    for (const feature of group.features) {
      const selected = modelFromEntry(settings.featureModels[feature.id]);
      if (!selected) continue;
      const fallback = feature.requiresVision ? vision : text;
      if (
        selected.channel !== fallback.channel ||
        selected.model !== fallback.model
      ) {
        overrides[feature.id] = selected;
      }
    }
  }

  const configuredEmbedding = settings.embeddingModel;
  const embeddingChannel = configuredEmbedding
    ? channelIdByProvider.get(configuredEmbedding.provider)
    : undefined;
  const embedding = embeddingChannel && configuredEmbedding?.upstreamModel.trim()
    ? {
        channel: embeddingChannel,
        model: configuredEmbedding.upstreamModel.trim(),
        dimension: configuredEmbedding.dimension,
        batchSize: configuredEmbedding.batchSize ?? profile.embedding.batchSize,
      }
    : null;
  if (!embedding) return null;

  const mediaModels = Object.fromEntries(
    Object.entries(settings.mediaModels).flatMap(([model, entry]) => {
      const channel = channelIdByProvider.get(entry.provider);
      if (!channel) return [];
      return [[
            model,
            {
              channel,
              model: entry.upstreamModel || model,
              ...(entry.mediaType ? { mediaType: entry.mediaType } : {}),
              ...(entry.label ? { label: entry.label } : {}),
              enabled: entry.enabled !== false,
              sortOrder: entry.sortOrder ?? 100,
              config: entry.config ?? {},
            },
          ] as const];
    }),
  );

  const next: QuickModelProfile = {
    ...profile,
    channels,
    featureModels: { text, vision, overrides },
    embedding,
    mediaModels,
  };
  try {
    return parseQuickModelProfile(JSON.stringify(next));
  } catch {
    return null;
  }
}

function QuickLocalNewApiSetup({
  config,
  loading,
  newApiBaseUrl,
  database,
}: {
  config: ModelGatewayConfig | undefined;
  loading: boolean;
  newApiBaseUrl: string;
  database: NewApiDatabaseConfigInput | undefined;
}) {
  const { t } = useTranslation();
  const saveProviderChannels = useSaveProviderChannels();
  const saveBatch = useSaveCustomChannelsBatch();
  const saveEmbedding = useSaveEmbeddingModel();
  const saveMedia = useSaveMediaModels();
  const addProviderChannel = useSettingsStore(
    (s) => s.addFeatureProviderChannel,
  );
  const updateProviderChannel = useSettingsStore(
    (s) => s.updateFeatureProviderChannel,
  );
  const updateFeatureModel = useSettingsStore((s) => s.updateFeatureModel);
  const setEmbeddingModel = useSettingsStore((s) => s.setEmbeddingModel);
  const setMediaModels = useSettingsStore((s) => s.setMediaModels);
  const advancedSettings = useSettingsStore((s) => s.featureModelConfig);
  const [upstreamKeys, setUpstreamKeys] = useState<Record<string, string>>({});
  const [recentlySavedChannels, setRecentlySavedChannels] = useState<
    SavedProviderChannelConfig[]
  >([]);
  const [storedProfiles] = useState(loadStoredQuickProfiles);
  const [selectedProfileKind, setSelectedProfileKind] =
    useState<QuickProfileKind>(
      storedProfiles.selected === "custom" && storedProfiles.customProfileJson
        ? "custom"
        : "recommended",
    );
  const [customProfileJson, setCustomProfileJson] = useState(
    storedProfiles.customProfileJson,
  );
  const [appliedProfileJson, setAppliedProfileJson] = useState(
    storedProfiles.appliedProfileJson,
  );
  const [applyError, setApplyError] = useState("");
  const [applyingStep, setApplyingStep] = useState("");
  const profileJson =
    selectedProfileKind === "recommended"
      ? RECOMMENDED_PROFILE_JSON
      : customProfileJson;
  const appliedProfileKind: QuickProfileKind | null = appliedProfileJson
    ? appliedProfileJson === RECOMMENDED_PROFILE_JSON
      ? "recommended"
      : "custom"
    : null;
  const parsedProfile = useMemo(() => {
    try {
      return parseQuickModelProfile(profileJson);
    } catch {
      return null;
    }
  }, [profileJson]);
  const advancedSettingsKey = JSON.stringify(advancedSettings);
  const previousAdvancedSettingsKey = useRef("");
  useEffect(() => {
    if (previousAdvancedSettingsKey.current === advancedSettingsKey) return;
    previousAdvancedSettingsKey.current = advancedSettingsKey;
    if (!appliedProfileJson) {
      const hasExistingAdvancedSettings =
        Object.keys(advancedSettings.providerChannels).length > 0 ||
        Object.keys(advancedSettings.featureModels).length > 0 ||
        Object.keys(advancedSettings.mediaModels).length > 0 ||
        Boolean(advancedSettings.embeddingModel);
      if (!hasExistingAdvancedSettings) return;
      const recoveredJson = JSON.stringify(
        syncQuickProfileFromAdvancedSettings(
          RECOMMENDED_LOCAL_NEWAPI_PROFILE,
          advancedSettings,
        ),
        null,
        2,
      );
      setSelectedProfileKind("custom");
      setCustomProfileJson(recoveredJson);
      setAppliedProfileJson(recoveredJson);
      saveStoredQuickProfiles({
        selected: "custom",
        customProfileJson: recoveredJson,
        appliedProfileJson: recoveredJson,
      });
      return;
    }
    let appliedProfile: QuickModelProfile;
    try {
      appliedProfile = parseQuickModelProfile(appliedProfileJson);
    } catch {
      return;
    }
    const syncedJson = JSON.stringify(
      syncQuickProfileFromAdvancedSettings(appliedProfile, advancedSettings),
      null,
      2,
    );
    if (syncedJson === appliedProfileJson) return;
    setCustomProfileJson(syncedJson);
    setAppliedProfileJson(syncedJson);
    saveStoredQuickProfiles({
      selected: selectedProfileKind,
      customProfileJson: syncedJson,
      appliedProfileJson: syncedJson,
    });
  }, [
    advancedSettings,
    advancedSettingsKey,
    appliedProfileJson,
    selectedProfileKind,
  ]);
  const localNewApiReady = Boolean(
    config?.custom?.configured && config?.provisioner?.database?.available,
  );
  const isPending = [
    saveProviderChannels,
    saveBatch,
    saveEmbedding,
    saveMedia,
  ].some((mutation) => mutation.isPending);

  const handleApply = async () => {
    setApplyError("");
    if (!localNewApiReady) {
      setApplyError(t("settings.modelConfig.quick.initializeFirst"));
      return;
    }
    let profile: QuickModelProfile;
    try {
      profile = parseQuickModelProfile(profileJson);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setApplyError(t("settings.modelConfig.quick.invalidJson", { message }));
      return;
    }

    const usedChannelIds = new Set<string>([
      profile.featureModels.text.channel,
      profile.featureModels.vision.channel,
      profile.embedding.channel,
      ...Object.values(profile.featureModels.overrides).map(
        (item) => item.channel,
      ),
      ...Object.values(profile.mediaModels).map((item) => item.channel),
    ]);
    const activeChannels = profile.channels.filter((channel) =>
      usedChannelIds.has(channel.id),
    );
    const savedProviderByName = new Map(
      [
        ...(config?.provisioner?.providerChannels ?? []),
        ...recentlySavedChannels,
      ].map((channel) => [channel.provider, channel]),
    );
    const channelsToSave = profile.channels.filter(
      (channel) =>
        usedChannelIds.has(channel.id) ||
        Boolean(upstreamKeys[channel.id]?.trim()) ||
        Boolean(savedProviderByName.get(channel.provider)?.configured),
    );
    const missingKeyChannels = activeChannels.filter(
      (channel) =>
        channel.provider !== "comfyui" &&
        !upstreamKeys[channel.id]?.trim() &&
        !savedProviderByName.get(channel.provider)?.configured,
    );
    if (missingKeyChannels.length > 0) {
      setApplyError(
        t("settings.modelConfig.quick.missingKeys", {
          channels: missingKeyChannels.map((channel) => channel.id).join("、"),
        }),
      );
      return;
    }
    const channelById = new Map(
      profile.channels.map((channel) => [channel.id, channel]),
    );
    const featureMappingsByChannel = new Map<string, Record<string, string>>();
    const selectedFeatureModels = new Map<string, QuickProfileModel>();
    for (const group of FEATURE_MODEL_GROUPS) {
      for (const feature of group.features) {
        const selected =
          profile.featureModels.overrides[feature.id] ??
          (feature.requiresVision
            ? profile.featureModels.vision
            : profile.featureModels.text);
        selectedFeatureModels.set(feature.id, selected);
        const mapping = featureMappingsByChannel.get(selected.channel) ?? {};
        mapping[feature.defaultModel] = selected.model.trim();
        featureMappingsByChannel.set(selected.channel, mapping);
      }
    }
    // Quick profiles configure the custom NewAPI stack, while ComfyUI mappings
    // are shared with Hybrid mode. Applying a profile that does not mention
    // ComfyUI must not erase those independently managed local overrides.
    const mediaModels: Record<string, SavedMediaModelConfig> =
      Object.fromEntries(
        Object.entries(config?.provisioner?.mediaModels ?? {}).filter(
          ([, item]) => item.provider === "comfyui",
        ),
      );
    for (const [rawModel, item] of Object.entries(profile.mediaModels)) {
      const model = rawModel.trim();
      const upstreamModel = item.model.trim();
      const channel = channelById.get(item.channel)!;
      if (model && upstreamModel)
        mediaModels[model] = {
          provider: channel.provider,
          upstreamModel,
          ...(item.mediaType ? { mediaType: item.mediaType } : {}),
          ...(item.label ? { label: item.label } : {}),
          enabled: item.enabled !== false,
          sortOrder: item.sortOrder ?? 100,
          config: item.config ?? {},
        };
    }

    const fail = (step: string, response: unknown): never => {
      throw new Error(
        `${step}: ${getResponseErrorMessage(response, t("settings.modelConfig.requestFailed"))}`,
      );
    };
    try {
      setApplyingStep(t("settings.modelConfig.quick.steps.channel"));
      const channelResult = await saveProviderChannels.mutateAsync({
        preserveUnmentioned: true,
        channels: channelsToSave.map((channel) => ({
          provider: channel.provider,
          ...(channel.type ? { type: channel.type } : {}),
          ...(channel.provider !== "comfyui" && upstreamKeys[channel.id]?.trim()
            ? { upstreamKey: upstreamKeys[channel.id].trim() }
            : {}),
          baseUrl: channel.baseUrl.trim(),
          priority: channel.priority ?? 0,
          settings: normalizeProviderChannelSettings(
            channel.provider,
            channel.settings ?? {},
          ),
        })),
      });
      if (channelResult.ok !== true || !("data" in channelResult)) {
        fail(t("settings.modelConfig.quick.steps.channel"), channelResult);
      }
      const savedChannels =
        "data" in channelResult ? channelResult.data.channels : [];
      setRecentlySavedChannels(savedChannels);

      setApplyingStep(t("settings.modelConfig.quick.steps.features"));
      const featureResult = await saveBatch.mutateAsync({
        newApiBaseUrl: newApiBaseUrl.trim(),
        ...(database ? { database } : {}),
        channels: [...featureMappingsByChannel.entries()].map(
          ([channelId, modelMapping]) => {
            const channel = channelById.get(channelId)!;
            return {
              provider: channel.provider,
              ...(channel.type ? { type: channel.type } : {}),
              upstreamKey: upstreamKeys[channel.id]?.trim() ?? "",
              modelMapping,
              group: "default",
              priority: channel.priority ?? 0,
              weight: 0,
              baseUrl: channel.baseUrl.trim(),
              testModel: "",
              settings: normalizeProviderChannelSettings(
                channel.provider,
                channel.settings ?? {},
              ),
            };
          },
        ),
      });
      if (!featureResult.ok || featureResult.data.failed) {
        fail(t("settings.modelConfig.quick.steps.features"), featureResult);
      }

      setApplyingStep(t("settings.modelConfig.quick.steps.embedding"));
      const embeddingChannel = channelById.get(profile.embedding.channel)!;
      const embeddingResult = await saveEmbedding.mutateAsync({
        newApiBaseUrl: newApiBaseUrl.trim(),
        ...(database ? { database } : {}),
        provider: embeddingChannel.provider,
        upstreamModel: profile.embedding.model.trim(),
        dimension: profile.embedding.dimension,
        batchSize: profile.embedding.batchSize,
      });
      if (!embeddingResult.ok)
        fail(t("settings.modelConfig.quick.steps.embedding"), embeddingResult);

      if (Object.keys(mediaModels).length) {
        setApplyingStep(t("settings.modelConfig.quick.steps.media"));
        const mediaResult = await saveMedia.mutateAsync({
          newApiBaseUrl: newApiBaseUrl.trim(),
          ...(database ? { database } : {}),
          models: mediaModels,
        });
        if (!mediaResult.ok || mediaResult.data.failed) {
          fail(t("settings.modelConfig.quick.steps.media"), mediaResult);
        }
      }

      for (const channel of profile.channels) {
        addProviderChannel(channel.provider);
        updateProviderChannel(channel.provider, {
          upstreamKey: "",
          baseUrl: channel.baseUrl,
          priority: channel.priority ?? 0,
          settings: normalizeProviderChannelSettings(
            channel.provider,
            channel.settings ?? {},
          ),
        });
      }
      for (const group of FEATURE_MODEL_GROUPS) {
        for (const feature of group.features) {
          const selected = selectedFeatureModels.get(feature.id)!;
          const channel = channelById.get(selected.channel)!;
          updateFeatureModel(feature.id, {
            provider: channel.provider,
            model: selected.model,
          });
        }
      }
      setEmbeddingModel({
        provider: embeddingChannel.provider,
        upstreamModel: profile.embedding.model,
        dimension: profile.embedding.dimension,
        batchSize: profile.embedding.batchSize,
      });
      setMediaModels(mediaModels);
      // Applying a profile updates the advanced store by design. Mark that
      // snapshot as synchronized so it is not mistaken for a manual edit.
      previousAdvancedSettingsKey.current = JSON.stringify(
        useSettingsStore.getState().featureModelConfig,
      );
      const nextCustomProfileJson =
        selectedProfileKind === "custom" ? profileJson : customProfileJson;
      setAppliedProfileJson(profileJson);
      saveStoredQuickProfiles({
        selected: selectedProfileKind,
        customProfileJson: nextCustomProfileJson,
        appliedProfileJson: profileJson,
      });
      setUpstreamKeys({});
      toast.success(t("settings.modelConfig.quick.applied"));
    } catch (error) {
      const message = await getRequestErrorMessage(
        error,
        t("settings.modelConfig.requestFailed"),
      );
      setApplyError(message);
      toast.error(message);
    } finally {
      setApplyingStep("");
    }
  };

  return (
    <div className="mt-5 rounded-md border border-border/70 p-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h4 className="text-xs font-medium text-foreground">
            {t("settings.modelConfig.quick.title")}
          </h4>
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
            {t("settings.modelConfig.quick.description")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1 rounded-md border border-border/70 p-1">
          <Button
            type="button"
            size="sm"
            variant={
              selectedProfileKind === "recommended" ? "secondary" : "ghost"
            }
            className="h-6 px-2 text-[10px]"
            onClick={() => {
              setSelectedProfileKind("recommended");
              saveStoredQuickProfiles({
                selected: "recommended",
                customProfileJson,
                appliedProfileJson,
              });
            }}
          >
            {t("settings.modelConfig.quick.recommended")}
            {appliedProfileKind === "recommended"
              ? ` · ${t("settings.modelConfig.quick.active")}`
              : ""}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={selectedProfileKind === "custom" ? "secondary" : "ghost"}
            className="h-6 px-2 text-[10px]"
            onClick={() => {
              const nextCustom = customProfileJson || RECOMMENDED_PROFILE_JSON;
              setCustomProfileJson(nextCustom);
              setSelectedProfileKind("custom");
              saveStoredQuickProfiles({
                selected: "custom",
                customProfileJson: nextCustom,
                appliedProfileJson,
              });
            }}
          >
            {t("settings.modelConfig.quick.custom")}
            {appliedProfileKind === "custom"
              ? ` · ${t("settings.modelConfig.quick.active")}`
              : ""}
          </Button>
        </div>
      </div>

      <div className="mt-3 rounded-md border border-border/60 p-3">
        <p className="text-[11px] font-medium text-foreground">
          {t("settings.modelConfig.quick.channelKeysTitle")}
        </p>
        {parsedProfile ? (
          <div className="mt-3 space-y-3">
            {parsedProfile.channels
              .filter((channel) => channel.provider !== "comfyui")
              .map((channel) => {
                const saved = [
                  ...recentlySavedChannels,
                  ...(config?.provisioner?.providerChannels ?? []),
                ].find(
                  (item) =>
                    item.provider === channel.provider && item.configured,
                );
                return (
                  <div
                    key={channel.id}
                    className="grid grid-cols-[150px_minmax(0,1fr)] items-end gap-3"
                  >
                    <div className="pb-2 text-[11px] text-muted-foreground">
                      <p className="font-medium text-foreground">
                        {channel.id}
                      </p>
                      <p>{channel.provider}</p>
                    </div>
                    <FieldRow
                      secret
                      name={`quick-upstream-key-${channel.id}`}
                      autoComplete="off"
                      label={t("settings.modelConfig.quick.upstreamKey")}
                      value={upstreamKeys[channel.id] ?? ""}
                      onChange={(value) =>
                        setUpstreamKeys((current) => ({
                          ...current,
                          [channel.id]: value,
                        }))
                      }
                      placeholder={
                        saved
                          ? t(
                              "settings.modelConfig.quick.savedKeyPlaceholder",
                              {
                                preview: saved.upstreamKeyPreview,
                              },
                            )
                          : t(
                              "settings.modelConfig.quick.upstreamKeyPlaceholder",
                            )
                      }
                    />
                  </div>
                );
              })}
          </div>
        ) : (
          <p className="mt-2 text-[11px] text-amber-300">
            {t("settings.modelConfig.quick.fixJsonFirst")}
          </p>
        )}
        <p className="mt-2 text-[11px] text-muted-foreground">
          {t("settings.modelConfig.quick.keyHint")}
        </p>
      </div>

      <details className="mt-3 rounded-md border border-border/60 bg-white/[0.02]">
        <summary className="cursor-pointer px-3 py-2.5 text-[11px] font-medium text-foreground">
          {t("settings.modelConfig.quick.editJson")}
        </summary>
        <div className="border-t border-border/60 p-3">
          <Textarea
            value={profileJson}
            readOnly={selectedProfileKind === "recommended"}
            onChange={(event) => {
              const value = event.target.value;
              setCustomProfileJson(value);
              saveStoredQuickProfiles({
                selected: "custom",
                customProfileJson: value,
                appliedProfileJson,
              });
            }}
            spellCheck={false}
            className="min-h-72 resize-y font-mono text-[11px] leading-relaxed"
          />
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            {selectedProfileKind === "recommended"
              ? t("settings.modelConfig.quick.recommendedJsonHint")
              : t("settings.modelConfig.quick.jsonHint")}
          </p>
        </div>
      </details>
      {applyError ? (
        <p className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] leading-relaxed text-destructive">
          {applyError}
        </p>
      ) : null}
      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-[11px] text-muted-foreground">
          {applyingStep
            ? t("settings.modelConfig.quick.applying", { step: applyingStep })
            : !localNewApiReady
              ? t("settings.modelConfig.quick.initializeFirst")
              : t("settings.modelConfig.quick.applyHint")}
        </p>
        <Button
          type="button"
          size="sm"
          onClick={handleApply}
          disabled={loading || isPending || !localNewApiReady}
        >
          {isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {t("settings.modelConfig.quick.apply")}
        </Button>
      </div>
    </div>
  );
}

const FEATURE_PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI",
  midjourney: "Midjourney",
  azure: "Azure",
  ollama: "Ollama",
  midjourneyplus: "MidjourneyPlus",
  openaimax: "OpenAIMax",
  ohmygpt: "OhMyGPT",
  custom: "Custom",
  ails: "AILS",
  aiproxy: "AIProxy",
  palm: "PaLM",
  api2gpt: "API2GPT",
  aigc2d: "AIGC2D",
  anthropic: "Anthropic",
  baidu: "Baidu",
  zhipu: "Zhipu",
  ali: "Ali",
  xunfei: "Xunfei",
  "360": "360",
  openrouter: "OpenRouter",
  aiproxylibrary: "AIProxyLibrary",
  fastgpt: "FastGPT",
  tencent: "Tencent",
  gemini: "Gemini",
  moonshot: "Moonshot",
  zhipuv4: "ZhipuV4",
  perplexity: "Perplexity",
  lingyiwanwu: "LingYiWanWu",
  aws: "AWS",
  cohere: "Cohere",
  minimax: "MiniMax",
  sunoapi: "SunoAPI",
  dify: "Dify",
  jina: "Jina",
  cloudflare: "Cloudflare",
  siliconflow: "SiliconFlow",
  vertexai: "VertexAI",
  mistral: "Mistral",
  deepseek: "DeepSeek",
  mokaai: "MokaAI",
  volcengine: "VolcEngine",
  baiduv2: "BaiduV2",
  xinference: "Xinference",
  xai: "xAI",
  coze: "Coze",
  kling: "Kling",
  jimeng: "Jimeng",
  vidu: "Vidu",
  submodel: "Submodel",
  doubaovideo: "DoubaoVideo",
  sora: "Sora",
  replicate: "Replicate",
  codex: "Codex",
};

function featureProviderLabel(
  provider: string,
  channelTypes?: ReadonlyMap<string, NewApiChannelType>,
): string {
  return (
    channelTypes?.get(provider)?.name ||
    FEATURE_PROVIDER_LABELS[provider] ||
    provider
  );
}

function FeatureModelsBlock({
  showAdvancedLlm = true,
  newApiBaseUrl,
  database,
  savedProviderChannels,
  savedEmbeddingModel,
  savedMediaModels,
  mediaOnly = false,
  comfyOnly = false,
  excludeComfyUI = false,
  defaultComfyWorkflows,
  channelTypesEnabled = true,
}: {
  showAdvancedLlm?: boolean;
  newApiBaseUrl: string;
  database: NewApiDatabaseConfigInput | undefined;
  savedProviderChannels: SavedProviderChannelConfig[];
  savedEmbeddingModel: SavedEmbeddingModelConfig | undefined;
  savedMediaModels: Record<string, SavedMediaModelConfig>;
  mediaOnly?: boolean;
  comfyOnly?: boolean;
  excludeComfyUI?: boolean;
  defaultComfyWorkflows?: {
    model: string;
    workflows: Record<string, Record<string, unknown>>;
  };
  channelTypesEnabled?: boolean;
}) {
  const { t } = useTranslation();
  const featureModels = useSettingsStore(
    (s) => s.featureModelConfig.featureModels,
  );
  const providerChannels = useSettingsStore(
    (s) => s.featureModelConfig.providerChannels,
  );
  const channelTypesQuery = useNewApiChannelTypes(channelTypesEnabled);
  const channelTypeByProvider = useMemo(
    () =>
      new Map(
        channelTypesQuery.data?.ok
          ? channelTypesQuery.data.data.items.map(
              (item) => [item.provider, item] as const,
            )
          : [],
      ),
    [channelTypesQuery.data],
  );
  const saveBatch = useSaveCustomChannelsBatch();
  const addFeatureProviderChannel = useSettingsStore(
    (s) => s.addFeatureProviderChannel,
  );
  const updateFeatureProviderChannel = useSettingsStore(
    (s) => s.updateFeatureProviderChannel,
  );

  const configuredProviders = useMemo(
    () =>
      Object.keys(providerChannels)
        .filter(
          (provider) =>
            (!comfyOnly || provider === "comfyui") &&
            (!excludeComfyUI || provider !== "comfyui"),
        )
        .sort(),
    [comfyOnly, excludeComfyUI, providerChannels],
  );
  const textFeatureGroups = useMemo(
    () =>
      splitFeatureModelGroups(
        FEATURE_MODEL_PRODUCT_GROUPS,
        (feature) => !feature.requiresVision && feature.id !== "COGNEE",
      ),
    [],
  );
  const visionFeatureGroups = useMemo(
    () =>
      splitFeatureModelGroups(FEATURE_MODEL_PRODUCT_GROUPS, (feature) =>
        Boolean(feature.requiresVision),
      ),
    [],
  );
  const savedChannelByProvider = useMemo(() => {
    return new Map(
      savedProviderChannels.map((channel) => [channel.provider, channel]),
    );
  }, [savedProviderChannels]);

  const savedProviderChannelsKey = JSON.stringify(savedProviderChannels);
  const lastSyncedProviderChannelsKey = useRef("");
  useEffect(() => {
    if (lastSyncedProviderChannelsKey.current === savedProviderChannelsKey)
      return;
    lastSyncedProviderChannelsKey.current = savedProviderChannelsKey;
    for (const channel of savedProviderChannels) {
      const provider = channel.provider as FeatureModelProvider;
      const current =
        useSettingsStore.getState().featureModelConfig.providerChannels?.[
          provider
        ];
      const savedBaseUrl = channel.baseUrl ?? "";
      if (!current) {
        addFeatureProviderChannel(provider);
        updateFeatureProviderChannel(provider, {
          baseUrl: savedBaseUrl,
          priority: channel.priority ?? 0,
          settings: normalizeProviderChannelSettings(
            channel.provider,
            channel.settings ?? {},
          ),
        });
        continue;
      }
      if (!current.upstreamKey) {
        updateFeatureProviderChannel(provider, {
          baseUrl: savedBaseUrl,
          priority: channel.priority ?? current.priority,
          settings: normalizeProviderChannelSettings(
            channel.provider,
            channel.settings ?? current.settings,
          ),
        });
      }
    }
  }, [
    addFeatureProviderChannel,
    savedProviderChannels,
    savedProviderChannelsKey,
    updateFeatureProviderChannel,
  ]);

  const handleLoadDefaultComfyWorkflows = () => {
    if (!defaultComfyWorkflows) return;
    const current = providerChannels.comfyui;
    const currentSettings = current?.settings ?? {};
    const currentComfyUI =
      currentSettings.comfyui &&
      typeof currentSettings.comfyui === "object" &&
      !Array.isArray(currentSettings.comfyui)
        ? (currentSettings.comfyui as Record<string, unknown>)
        : {};
    const currentWorkflows = readComfyUIWorkflows(currentSettings);
    const currentModel = readComfyUIModelName(currentSettings);
    const model = currentModel || defaultComfyWorkflows.model;
    const workflows = {
      ...defaultComfyWorkflows.workflows,
      ...currentWorkflows,
    };
    const nextComfyUI = { ...currentComfyUI };
    delete nextComfyUI.workflow_by_model;
    delete nextComfyUI.workflow;
    addFeatureProviderChannel("comfyui");
    updateFeatureProviderChannel("comfyui", {
      baseUrl: current?.baseUrl || "http://127.0.0.1:8188",
      priority: current?.priority ?? 0,
      settings: {
        ...currentSettings,
        comfyui: {
          ...nextComfyUI,
          model_name: model,
          workflow_routes: buildComfyUIWorkflowRoutes(workflows),
        },
      },
    });
  };

  useEffect(() => {
    if (!defaultComfyWorkflows) return;
    const current = providerChannels.comfyui;
    if (!current || current.baseUrl.trim()) return;
    const workflows = readComfyUIWorkflows(current.settings);
    const hasLoadedTemplate = Object.keys(defaultComfyWorkflows.workflows).some(
      (model) => workflows[model],
    );
    if (!hasLoadedTemplate) return;
    updateFeatureProviderChannel("comfyui", {
      baseUrl: "http://127.0.0.1:8188",
    });
  }, [
    defaultComfyWorkflows,
    providerChannels.comfyui,
    updateFeatureProviderChannel,
  ]);

  // 把功能行按 provider 分组拼成渠道：modelMapping = { DC内部模型名: 上游模型名 }。
  const buildChannels = (): CustomChannelInput[] => {
    const byProvider = new Map<FeatureModelProvider, Record<string, string>>();
    for (const group of FEATURE_MODEL_GROUPS) {
      for (const feature of group.features) {
        const entry = featureModels[feature.id];
        if (!entry || !entry.model.trim() || !providerChannels[entry.provider])
          continue;
        const mapping = byProvider.get(entry.provider) ?? {};
        mapping[feature.defaultModel] = entry.model.trim();
        byProvider.set(entry.provider, mapping);
      }
    }
    return [...byProvider.entries()].map(([provider, modelMapping]) => {
      const channel = providerChannels[provider];
      return {
        provider,
        type:
          channelTypeByProvider.get(provider)?.type ||
          savedChannelByProvider.get(provider)?.type,
        upstreamKey: (channel?.upstreamKey ?? "").trim(),
        modelMapping,
        group: "default",
        priority: channel?.priority ?? 0,
        weight: 0,
        baseUrl: (channel?.baseUrl ?? "").trim(),
        testModel: "",
        settings: normalizeProviderChannelSettings(
          provider,
          channel?.settings ?? {},
        ),
      };
    });
  };

  const handleSave = async () => {
    if (configuredProviders.length === 0) {
      toast.error(t("settings.modelConfig.featureModels.noChannels"));
      return;
    }
    const channels = buildChannels();
    if (channels.length === 0) {
      toast.error(t("settings.modelConfig.featureModels.noMappings"));
      return;
    }
    if (!newApiBaseUrl.trim()) {
      toast.error(t("settings.modelConfig.featureModels.missingBaseUrl"));
      return;
    }
    const missing = channels
      .filter((c) => {
        if (c.provider === "comfyui") return false;
        if (c.upstreamKey) return false;
        return !savedChannelByProvider.get(c.provider)?.configured;
      })
      .map((c) => featureProviderLabel(c.provider, channelTypeByProvider));
    if (missing.length > 0) {
      toast.error(
        t("settings.modelConfig.featureModels.missingKeys", {
          providers: missing.join("、"),
        }),
      );
      return;
    }
    try {
      const res = await saveBatch.mutateAsync({
        newApiBaseUrl: newApiBaseUrl.trim(),
        ...(database ? { database } : {}),
        channels,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      const { succeeded, failed } = res.data;
      if (failed > 0) {
        toast.warning(
          t("settings.modelConfig.featureModels.savedPartial", {
            succeeded,
            failed,
          }),
        );
      } else {
        toast.success(
          t("settings.modelConfig.featureModels.saved", { count: succeeded }),
        );
      }
    } catch {
      toast.error(t("settings.modelConfig.requestFailed"));
    }
  };

  return (
    <>
      {defaultComfyWorkflows ? (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2.5">
          <p className="text-xs text-muted-foreground">
            {t("settings.modelConfig.quick.comfyTemplateHint")}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={handleLoadDefaultComfyWorkflows}
          >
            <Plus className="size-3.5" />
            {t("settings.modelConfig.quick.loadComfyTemplate")}
          </Button>
        </div>
      ) : null}
      <ProviderChannelsBlock
        savedProviderChannels={savedProviderChannels}
        newApiBaseUrl={newApiBaseUrl}
        database={database}
        channelTypes={
          channelTypesQuery.data?.ok ? channelTypesQuery.data.data.items : []
        }
        channelTypesLoading={channelTypesQuery.isLoading}
        allowedProviders={comfyOnly ? ["comfyui"] : undefined}
        excludedProviders={excludeComfyUI ? ["comfyui"] : undefined}
      />

      {!mediaOnly && showAdvancedLlm ? (
        <CogneeModelsBlock
          configuredProviders={configuredProviders}
          newApiBaseUrl={newApiBaseUrl}
          database={database}
          providerChannels={providerChannels}
          savedChannelByProvider={savedChannelByProvider}
        />
      ) : null}

      {!mediaOnly ? (
        <EmbeddingModelBlock
          configuredProviders={configuredProviders}
          newApiBaseUrl={newApiBaseUrl}
          database={database}
          savedChannelByProvider={savedChannelByProvider}
          savedEmbeddingModel={savedEmbeddingModel}
        />
      ) : null}

      {/* 功能模型映射 */}
      {!mediaOnly && showAdvancedLlm ? (
        <>
          <h4 className="mt-5 text-xs font-medium text-foreground">
            {t("settings.modelConfig.featureModels.title")}
          </h4>
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
            {t("settings.modelConfig.featureModels.description")}
          </p>

          <FeatureModelCapabilitySection
            title={t("settings.modelConfig.featureModels.textModelsTitle")}
            groups={textFeatureGroups}
            newApiBaseUrl={newApiBaseUrl}
            database={database}
            configuredProviders={configuredProviders}
            providerChannels={providerChannels}
            savedChannelByProvider={savedChannelByProvider}
          />

          <FeatureModelCapabilitySection
            title={t(
              "settings.modelConfig.featureModels.multimodalModelsTitle",
            )}
            hint={t("settings.modelConfig.featureModels.visionRequiredHint")}
            groups={visionFeatureGroups}
            newApiBaseUrl={newApiBaseUrl}
            database={database}
            configuredProviders={configuredProviders}
            providerChannels={providerChannels}
            savedChannelByProvider={savedChannelByProvider}
          />

          <div className="mt-3 flex items-center justify-end gap-3">
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {t("settings.modelConfig.featureModels.saveHint")}
            </p>
            <Button
              type="button"
              size="sm"
              className="shrink-0"
              onClick={handleSave}
              disabled={saveBatch.isPending}
            >
              {saveBatch.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : null}
              {t("settings.modelConfig.featureModels.save")}
            </Button>
          </div>
        </>
      ) : null}
      <MediaModelsBlock
        configuredProviders={configuredProviders}
        newApiBaseUrl={newApiBaseUrl}
        database={database}
        savedChannelByProvider={savedChannelByProvider}
        savedMediaModels={savedMediaModels}
        comfyOnly={comfyOnly}
        excludeComfyUI={excludeComfyUI}
      />
    </>
  );
}

function CogneeModelsBlock({
  configuredProviders,
  newApiBaseUrl,
  database,
  providerChannels,
  savedChannelByProvider,
}: {
  configuredProviders: readonly FeatureModelProvider[];
  newApiBaseUrl: string;
  database: NewApiDatabaseConfigInput | undefined;
  providerChannels: Record<string, { upstreamKey: string; baseUrl: string }>;
  savedChannelByProvider: Map<string, SavedProviderChannelConfig>;
}) {
  const { t } = useTranslation();

  return (
    <div className="mt-6 rounded-md border border-border/70 px-3 py-3">
      <h4 className="text-xs font-medium text-foreground">
        {t("settings.modelConfig.featureModels.groups.novelImport")}
      </h4>
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
        {t("settings.modelConfig.featureModels.cogneeDescription")}
      </p>

      <div
        className={cn(
          FEATURE_ROW_GRID,
          "mt-3 text-[11px] font-medium tracking-wide text-muted-foreground uppercase",
        )}
      >
        <span>{t("settings.modelConfig.featureModels.colFeature")}</span>
        <span>{t("settings.modelConfig.featureModels.colProvider")}</span>
        <span>{t("settings.modelConfig.featureModels.colModel")}</span>
      </div>
      <div className="mt-2">
        <FeatureModelRow
          featureId="COGNEE"
          defaultModel="DC-cognee-LLM"
          requiresVision={false}
          newApiBaseUrl={newApiBaseUrl}
          database={database}
          configuredProviders={configuredProviders}
          providerChannels={providerChannels}
          savedChannelByProvider={savedChannelByProvider}
        />
      </div>

    </div>
  );
}

function EmbeddingModelBlock({
  configuredProviders,
  newApiBaseUrl,
  database,
  savedChannelByProvider,
  savedEmbeddingModel,
}: {
  configuredProviders: readonly FeatureModelProvider[];
  newApiBaseUrl: string;
  database: NewApiDatabaseConfigInput | undefined;
  savedChannelByProvider: Map<string, SavedProviderChannelConfig>;
  savedEmbeddingModel: SavedEmbeddingModelConfig | undefined;
}) {
  const { t } = useTranslation();
  const localSavedEmbeddingModel = useSettingsStore(
    (s) => s.featureModelConfig.embeddingModel,
  );
  const setEmbeddingModel = useSettingsStore((s) => s.setEmbeddingModel);
  const saveEmbeddingModel = useSaveEmbeddingModel();
  const [localModel, setLocalModel] = useState<EmbeddingModelEntry | undefined>(
    localSavedEmbeddingModel,
  );
  const savedKey = JSON.stringify(savedEmbeddingModel ?? null);
  const localSavedKey = JSON.stringify(localSavedEmbeddingModel ?? null);
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    const fromBackend = savedEmbeddingModel
      ? {
          provider: savedEmbeddingModel.provider as FeatureModelProvider,
          upstreamModel: savedEmbeddingModel.upstreamModel,
          dimension: savedEmbeddingModel.dimension,
          batchSize: savedEmbeddingModel.batchSize,
        }
      : undefined;
    const next = fromBackend ?? localSavedEmbeddingModel;
    const nextKey = JSON.stringify(next ?? null);
    setLocalModel((current) =>
      JSON.stringify(current ?? null) === nextKey ? current : next,
    );
  }, [localSavedEmbeddingModel, localSavedKey, savedEmbeddingModel, savedKey]);

  const selectedProvider = localModel?.provider ?? "";
  const upstreamModel = localModel?.upstreamModel ?? "";
  const dimension =
    localModel === undefined
      ? DEFAULT_EMBEDDING_DIMENSION
      : localModel.dimension;
  const batchSize =
    localModel === undefined
      ? DEFAULT_EMBEDDING_BATCH_SIZE
      : localModel.batchSize;

  const updateLocal = (patch: Partial<EmbeddingModelEntry>) => {
    setLocalModel((prev) => ({
      provider:
        patch.provider ?? prev?.provider ?? configuredProviders[0] ?? "ali",
      upstreamModel: patch.upstreamModel ?? prev?.upstreamModel ?? "",
      dimension:
        patch.dimension ?? prev?.dimension ?? DEFAULT_EMBEDDING_DIMENSION,
      batchSize:
        "batchSize" in patch
          ? patch.batchSize
          : (prev?.batchSize ?? DEFAULT_EMBEDDING_BATCH_SIZE),
    }));
  };

  const handleSave = async () => {
    setSaveError("");
    if (configuredProviders.length === 0) {
      toast.error(t("settings.modelConfig.embeddingModel.noChannels"));
      return;
    }
    const provider = localModel?.provider;
    if (!provider || !configuredProviders.includes(provider)) {
      toast.error(t("settings.modelConfig.embeddingModel.missingProvider"));
      return;
    }
    if (!savedChannelByProvider.get(provider)?.configured) {
      const message = t("settings.modelConfig.featureModels.missingKeys", {
        providers: featureProviderLabel(provider),
      });
      setSaveError(message);
      toast.error(message);
      return;
    }
    const model = upstreamModel.trim();
    if (!model) {
      toast.error(t("settings.modelConfig.embeddingModel.missingModel"));
      return;
    }
    const normalizedDimension = Number(dimension);
    if (!Number.isInteger(normalizedDimension) || normalizedDimension <= 0) {
      toast.error(t("settings.modelConfig.embeddingModel.invalidDimension"));
      return;
    }
    const normalizedBatchSize =
      batchSize == null || String(batchSize).trim() === ""
        ? undefined
        : Math.round(Number(batchSize));
    if (
      normalizedBatchSize !== undefined &&
      (!Number.isFinite(normalizedBatchSize) || normalizedBatchSize <= 0)
    ) {
      toast.error(t("settings.modelConfig.embeddingModel.invalidBatchSize"));
      return;
    }
    if (!newApiBaseUrl.trim()) {
      toast.error(t("settings.modelConfig.featureModels.missingBaseUrl"));
      return;
    }
    try {
      const res = await saveEmbeddingModel.mutateAsync({
        newApiBaseUrl: newApiBaseUrl.trim(),
        ...(database ? { database } : {}),
        provider,
        upstreamModel: model,
        dimension: normalizedDimension,
        ...(normalizedBatchSize ? { batchSize: normalizedBatchSize } : {}),
      });
      if (!res.ok) {
        const message = getResponseErrorMessage(
          res,
          t("settings.modelConfig.requestFailed"),
        );
        setSaveError(message);
        toast.error(message);
        return;
      }
      const saved = {
        provider: res.data.embeddingModel.provider as FeatureModelProvider,
        upstreamModel: res.data.embeddingModel.upstreamModel,
        dimension: res.data.embeddingModel.dimension,
        batchSize: res.data.embeddingModel.batchSize,
      };
      setEmbeddingModel(saved);
      setLocalModel(saved);
      toast.success(t("settings.modelConfig.embeddingModel.saved"));
    } catch (error) {
      const message = await getRequestErrorMessage(
        error,
        t("settings.modelConfig.requestFailed"),
      );
      setSaveError(message);
      toast.error(message);
    }
  };

  return (
    <div className="mt-6">
      <h4 className="text-xs font-medium text-foreground">
        {t("settings.modelConfig.embeddingModel.title")}
      </h4>
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
        {t("settings.modelConfig.embeddingModel.description")}
      </p>

      <div className="mt-3 rounded-md border border-border/70 px-3 py-3">
        <div className="grid grid-cols-[140px_minmax(0,1fr)_100px_110px] items-center gap-3 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          <span>{t("settings.modelConfig.embeddingModel.colProvider")}</span>
          <span>
            {t("settings.modelConfig.embeddingModel.colUpstreamModel")}
          </span>
          <span>{t("settings.modelConfig.embeddingModel.colDimension")}</span>
          <span>{t("settings.modelConfig.embeddingModel.colBatchSize")}</span>
        </div>
        <div className="mt-2 grid grid-cols-[140px_minmax(0,1fr)_100px_110px] items-center gap-3">
          <Select
            value={selectedProvider}
            onValueChange={(provider) =>
              updateLocal({ provider: provider as FeatureModelProvider })
            }
            disabled={configuredProviders.length === 0}
          >
            <SelectTrigger size="sm" className="w-full">
              <SelectValue
                placeholder={t(
                  "settings.modelConfig.embeddingModel.defaultProvider",
                )}
              >
                {(provider: string) => featureProviderLabel(provider)}
              </SelectValue>
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              {configuredProviders.map((provider) => (
                <SelectItem key={provider} value={provider}>
                  {featureProviderLabel(provider)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            value={upstreamModel}
            onChange={(event) =>
              updateLocal({ upstreamModel: event.target.value })
            }
            placeholder={t(
              "settings.modelConfig.embeddingModel.upstreamModelPlaceholder",
            )}
            className="h-8 rounded-md border-input/80 focus-visible:border-ring/70 focus-visible:ring-1 focus-visible:ring-ring/30"
            disabled={configuredProviders.length === 0}
          />
          <Input
            value={String(dimension)}
            onChange={(event) => {
              if (event.target.value.trim()) {
                updateLocal({
                  dimension: Number(event.target.value),
                });
              }
            }}
            inputMode="numeric"
            min={1}
            step={1}
            type="number"
            className="h-8 rounded-md border-input/80 focus-visible:border-ring/70 focus-visible:ring-1 focus-visible:ring-ring/30"
            disabled={configuredProviders.length === 0}
          />
          <Input
            value={batchSize == null ? "" : String(batchSize)}
            onChange={(event) =>
              updateLocal({
                batchSize: event.target.value.trim()
                  ? Number(event.target.value)
                  : undefined,
              })
            }
            inputMode="numeric"
            min={1}
            step={1}
            type="number"
            placeholder={t(
              "settings.modelConfig.embeddingModel.batchSizePlaceholder",
            )}
            className="h-8 rounded-md border-input/80 focus-visible:border-ring/70 focus-visible:ring-1 focus-visible:ring-ring/30"
            disabled={configuredProviders.length === 0}
          />
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-amber-300/80">
          {t("settings.modelConfig.embeddingModel.dimensionWarning")}
        </p>
      </div>

      {saveError ? (
        <p className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] leading-relaxed text-destructive">
          {saveError}
        </p>
      ) : null}

      <div className="mt-3 flex items-center justify-end gap-3">
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {configuredProviders.length > 0
            ? t("settings.modelConfig.embeddingModel.saveHint")
            : t("settings.modelConfig.embeddingModel.noChannelsHint")}
        </p>
        <Button
          type="button"
          size="sm"
          className="shrink-0"
          onClick={handleSave}
          disabled={
            configuredProviders.length === 0 || saveEmbeddingModel.isPending
          }
        >
          {saveEmbeddingModel.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : null}
          {t("settings.modelConfig.embeddingModel.save")}
        </Button>
      </div>
    </div>
  );
}

function defaultComfyMediaModelConfig(
  model: string,
  workflowIds: readonly string[] = [],
): MediaModelEntry {
  const routeTokens = new Set(
    (workflowIds.length > 0 ? workflowIds : [model]).flatMap((value) =>
      value.trim().toLowerCase().replace(/-/g, "_").split("_"),
    ),
  );
  const supportedModes: string[] = [];
  const referenceCapabilities: Record<string, number | boolean> = {};
  const isMiniMaxH3Local = model.trim().toLowerCase() === "minimax-h3-local";
  const resolutionOptions = isMiniMaxH3Local
    ? ["480p", "768p", "1080p"]
    : ["480p", "640p"];
  const ratioOptions = isMiniMaxH3Local
    ? ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]
    : routeTokens.has("i2v")
      ? ["16:9", "1:1"]
      : ["1:1", "16:9"];
  if (
    routeTokens.has("t2v") ||
    (!routeTokens.has("i2v") && !routeTokens.has("r2v"))
  ) {
    supportedModes.push("text_to_video");
  }
  if (routeTokens.has("i2v")) {
    supportedModes.push(
      ...(isMiniMaxH3Local
        ? ["first_frame"]
        : ["image_to_video", "image_reference"]),
    );
    referenceCapabilities.referenceImageMax = 1;
  }
  if (routeTokens.has("r2v")) {
    supportedModes.push("all_reference");
    referenceCapabilities.referenceImageMax = 9;
    referenceCapabilities.referenceVideoMax = 3;
    referenceCapabilities.referenceAudioMax = 3;
  }
  return {
    provider: "comfyui",
    upstreamModel: model,
    mediaType: "video",
    label: model,
    enabled: true,
    sortOrder: 100,
    config: {
      request: { endpoint: "video/generations", parameters: [] },
      resolutionOptions,
      ratioOptions,
      minDuration: 4,
      maxDuration: 15,
      supportedModes,
      ...referenceCapabilities,
      [COMFY_WORKFLOW_MANAGED_CONFIG_KEY]: true,
    },
  };
}

function detachComfyWorkflowManagedConfig(
  entry: MediaModelEntry | undefined,
): MediaModelEntry | undefined {
  if (!entry?.config?.[COMFY_WORKFLOW_MANAGED_CONFIG_KEY]) return entry;
  const config = { ...entry.config };
  delete config[COMFY_WORKFLOW_MANAGED_CONFIG_KEY];
  return { ...entry, config };
}

function isBareComfyWorkflowMediaModel(entry: MediaModelEntry): boolean {
  if (entry.provider !== "comfyui") return false;
  const keys = Object.keys(entry.config ?? {});
  return keys.every(
    (key) => key === "request" || key === COMFY_WORKFLOW_MANAGED_CONFIG_KEY,
  );
}

function MediaModelsBlock({
  configuredProviders,
  newApiBaseUrl,
  database,
  savedChannelByProvider,
  savedMediaModels,
  comfyOnly = false,
  excludeComfyUI = false,
}: {
  configuredProviders: readonly FeatureModelProvider[];
  newApiBaseUrl: string;
  database: NewApiDatabaseConfigInput | undefined;
  savedChannelByProvider: Map<string, SavedProviderChannelConfig>;
  savedMediaModels: Record<string, SavedMediaModelConfig>;
  comfyOnly?: boolean;
  excludeComfyUI?: boolean;
}) {
  const { t } = useTranslation();
  const localSavedMediaModels = useSettingsStore(
    (s) => s.featureModelConfig.mediaModels ?? {},
  );
  const providerChannels = useSettingsStore(
    (s) => s.featureModelConfig.providerChannels,
  );
  const setMediaModels = useSettingsStore((s) => s.setMediaModels);
  const saveProviderChannels = useSaveProviderChannels();
  const saveMediaModels = useSaveMediaModels();
  const [mediaModels, setLocalMediaModels] = useState(localSavedMediaModels);
  const [saveError, setSaveError] = useState("");
  const [editingModel, setEditingModel] = useState<string | null>(null);
  const [creatingModel, setCreatingModel] = useState(false);
  const savedMediaModelsKey = JSON.stringify(savedMediaModels);
  const localSavedMediaModelsKey = JSON.stringify(localSavedMediaModels);
  const comfyWorkflowModels = useMemo(() => {
    const model = readComfyUIModelName(
      providerChannels.comfyui?.settings ?? {},
    );
    return model ? [model] : [];
  }, [providerChannels.comfyui?.settings]);
  const comfyWorkflowIds = useMemo(
    () =>
      Object.keys(
        readComfyUIWorkflows(providerChannels.comfyui?.settings ?? {}),
      ).sort(),
    [providerChannels.comfyui?.settings],
  );
  const mediaModelRows = useMemo(() => {
    const presetKinds = new Map(
      MEDIA_MODEL_ROWS.map((row) => [row.model, row.kind]),
    );
    const models = comfyOnly
      ? Object.keys(mediaModels).filter(
          (model) => mediaModels[model]?.provider === "comfyui",
        )
      : Array.from(
          new Set([
            ...MEDIA_MODEL_ROWS.map((row) => row.model),
            ...Object.keys(mediaModels),
          ]),
        ).filter(
          (model) =>
            !excludeComfyUI || mediaModels[model]?.provider !== "comfyui",
        );
    return models
      .map((model) => {
        const entry = mediaModels[model];
        return {
          model,
          kind: entry?.mediaType ?? presetKinds.get(model) ?? "video",
          officialOnly: false,
          mainline: MAINLINE_MEDIA_MODEL_IDS.has(model),
          sortOrder: entry?.sortOrder ?? 100,
        };
      })
      .sort(
        (left, right) =>
          left.sortOrder - right.sortOrder ||
          left.model.localeCompare(right.model),
      );
  }, [comfyOnly, excludeComfyUI, mediaModels]);

  useEffect(() => {
    const fromBackend = Object.fromEntries(
      Object.entries(savedMediaModels).map(([model, entry]) => [
        model,
        {
          provider: entry.provider as FeatureModelProvider,
          upstreamModel: entry.upstreamModel,
          ...(entry.mediaType ? { mediaType: entry.mediaType } : {}),
          ...(entry.label ? { label: entry.label } : {}),
          enabled: entry.enabled !== false,
          sortOrder: entry.sortOrder ?? 100,
          config: entry.config ?? {},
        },
      ]),
    );
    const next =
      Object.keys(fromBackend).length > 0 ? fromBackend : localSavedMediaModels;
    const nextKey = JSON.stringify(next ?? {});
    setLocalMediaModels((current) =>
      JSON.stringify(current ?? {}) === nextKey ? current : (next ?? {}),
    );
  }, [localSavedMediaModelsKey, savedMediaModelsKey]);

  useEffect(() => {
    setLocalMediaModels((current) => {
      let changed = false;
      const next = { ...current };
      const workflowModelSet = new Set(comfyWorkflowModels);
      for (const [model, entry] of Object.entries(next)) {
        if (
          entry.config?.[COMFY_WORKFLOW_MANAGED_CONFIG_KEY] === true &&
          !workflowModelSet.has(model)
        ) {
          delete next[model];
          changed = true;
        }
      }
      for (const model of comfyWorkflowModels) {
        const existing = next[model];
        if (!existing) {
          next[model] = defaultComfyMediaModelConfig(model, comfyWorkflowIds);
          changed = true;
        } else if (isBareComfyWorkflowMediaModel(existing)) {
          const defaults = defaultComfyMediaModelConfig(
            model,
            comfyWorkflowIds,
          );
          next[model] = {
            ...defaults,
            ...existing,
            config: { ...defaults.config, ...(existing.config ?? {}) },
          };
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [comfyWorkflowIds, comfyWorkflowModels]);

  const handleSave = async () => {
    setSaveError("");
    const next: typeof localSavedMediaModels = {};
    for (const row of mediaModelRows) {
      if (row.officialOnly) continue;
      const entry = mediaModels[row.model];
      if (entry?.provider && configuredProviders.includes(entry.provider)) {
        next[row.model] = {
          provider: entry.provider,
          upstreamModel: entry.upstreamModel.trim(),
          ...(entry.mediaType ? { mediaType: entry.mediaType } : {}),
          ...(entry.label ? { label: entry.label } : {}),
          enabled: entry.enabled !== false,
          sortOrder: entry.sortOrder ?? 100,
          config: entry.config ?? {},
        };
      }
    }
    if (!comfyOnly) {
      for (const [model, entry] of Object.entries(mediaModels)) {
        if (excludeComfyUI && entry.provider === "comfyui") {
          next[model] = entry;
        }
      }
    }
    if (Object.keys(next).length === 0) {
      toast.error(t("settings.modelConfig.mediaModels.noMappings"));
      return;
    }
    const missingProviders = Array.from(
      new Set(
        Object.values(next)
          .map((entry) => entry.provider)
          .filter(
            (provider) =>
              provider !== "comfyui" &&
              !(providerChannels[provider]?.upstreamKey ?? "").trim() &&
              !savedChannelByProvider.get(provider)?.configured,
          ),
      ),
    );
    if (missingProviders.length > 0) {
      const message = t("settings.modelConfig.featureModels.missingKeys", {
        providers: missingProviders
          .map((provider) => featureProviderLabel(provider))
          .join("、"),
      });
      setSaveError(message);
      toast.error(message);
      return;
    }
    if (!newApiBaseUrl.trim()) {
      toast.error(t("settings.modelConfig.featureModels.missingBaseUrl"));
      return;
    }
    try {
      if (comfyOnly) {
        const comfyChannel = providerChannels.comfyui;
        if (!comfyChannel) {
          toast.error(t("settings.modelConfig.featureModels.noChannels"));
          return;
        }
        const channelResult = await saveProviderChannels.mutateAsync({
          preserveUnmentioned: true,
          channels: [
            {
              provider: "comfyui",
              type: savedChannelByProvider.get("comfyui")?.type ?? 63,
              baseUrl: comfyChannel.baseUrl.trim(),
              priority: comfyChannel.priority ?? 0,
              settings: normalizeProviderChannelSettings(
                "comfyui",
                comfyChannel.settings ?? {},
              ),
            },
          ],
        });
        if (channelResult.ok !== true) {
          const message = getResponseErrorMessage(
            channelResult,
            t("settings.modelConfig.requestFailed"),
          );
          setSaveError(message);
          toast.error(message);
          return;
        }
      }
      const res = await saveMediaModels.mutateAsync({
        newApiBaseUrl: newApiBaseUrl.trim(),
        ...(database ? { database } : {}),
        models: next,
      });
      if (!res.ok) {
        const message = getResponseErrorMessage(
          res,
          t("settings.modelConfig.requestFailed"),
        );
        setSaveError(message);
        toast.error(message);
        return;
      }
      const { succeeded, failed, models, results } = res.data;
      if (failed > 0) {
        const firstError = results.find((item) => item.error)?.error;
        const message =
          firstError ||
          t("settings.modelConfig.featureModels.savedPartial", {
            succeeded,
            failed,
          });
        setSaveError(message);
        toast.warning(message);
        return;
      }
      const saved = Object.fromEntries(
        Object.entries(models).map(([model, entry]) => [
          model,
          {
            provider: entry.provider as FeatureModelProvider,
            upstreamModel: entry.upstreamModel,
            ...(entry.mediaType ? { mediaType: entry.mediaType } : {}),
            ...(entry.label ? { label: entry.label } : {}),
            enabled: entry.enabled !== false,
            sortOrder: entry.sortOrder ?? 100,
            config: entry.config ?? {},
          },
        ]),
      );
      setMediaModels(saved);
      setLocalMediaModels(saved);
      toast.success(t("settings.modelConfig.mediaModels.saved"));
    } catch (error) {
      const message = await getRequestErrorMessage(
        error,
        t("settings.modelConfig.requestFailed"),
      );
      setSaveError(message);
      toast.error(message);
    }
  };

  return (
    <div className="mt-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="text-xs font-medium text-foreground">
            {t("settings.modelConfig.mediaModels.title")}
          </h4>
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
            {t("settings.modelConfig.mediaModels.description")}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setCreatingModel(true)}
        >
          <Plus className="size-3.5" />
          {t("settings.modelConfig.mediaModels.addModel")}
        </Button>
      </div>

      <div
        className={cn(
          MEDIA_ROW_GRID,
          "mt-3 px-3 text-[11px] font-medium tracking-wide text-muted-foreground uppercase",
        )}
      >
        <span>{t("settings.modelConfig.mediaModels.colType")}</span>
        <span>{t("settings.modelConfig.mediaModels.colModel")}</span>
        <span>{t("settings.modelConfig.mediaModels.colProvider")}</span>
        <span>{t("settings.modelConfig.mediaModels.colUpstreamModel")}</span>
        <span>{t("settings.modelConfig.mediaModels.colActions")}</span>
      </div>

      <div className="mt-2 rounded-md border border-border/70">
        {mediaModelRows.map((row, index) => {
          const entry = mediaModels[row.model];
          const value = entry?.provider ?? "";
          return (
            <div
              key={row.model}
              className={cn(
                MEDIA_ROW_GRID,
                "px-3 py-2.5",
                index > 0 && "border-t border-border/70",
              )}
            >
              <span className="text-xs text-muted-foreground">
                {t(`settings.modelConfig.mediaModels.types.${row.kind}`)}
              </span>
              <code className="truncate rounded border border-border/60 bg-white/[0.03] px-2 py-1.5 text-[11px] text-muted-foreground">
                {row.model}
              </code>
              {row.officialOnly ? (
                <div className="h-8 rounded-md border border-border/60 bg-white/[0.03] px-3 py-1.5 text-xs text-muted-foreground">
                  {t("settings.modelConfig.mediaModels.officialOnly")}
                </div>
              ) : (
                <Select
                  value={value}
                  onValueChange={(provider) =>
                    setLocalMediaModels((prev) => ({
                      ...prev,
                      [row.model]: {
                        ...detachComfyWorkflowManagedConfig(prev[row.model]),
                        provider: provider as FeatureModelProvider,
                        upstreamModel: prev[row.model]?.upstreamModel ?? "",
                      },
                    }))
                  }
                  disabled={configuredProviders.length === 0}
                >
                  <SelectTrigger size="sm" className="w-full">
                    <SelectValue
                      placeholder={t(
                        "settings.modelConfig.mediaModels.defaultProvider",
                      )}
                    >
                      {(provider: string) => featureProviderLabel(provider)}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    {configuredProviders.map((provider) => (
                      <SelectItem key={provider} value={provider}>
                        {featureProviderLabel(provider)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {row.officialOnly ? (
                <div className="h-8 rounded-md border border-border/60 bg-white/[0.03] px-3 py-1.5 text-xs text-muted-foreground">
                  {t("settings.modelConfig.mediaModels.officialOnly")}
                </div>
              ) : (
                <Input
                  value={entry?.upstreamModel ?? ""}
                  onChange={(event) =>
                    setLocalMediaModels((prev) => ({
                      ...prev,
                      [row.model]: {
                        ...detachComfyWorkflowManagedConfig(prev[row.model]),
                        provider:
                          prev[row.model]?.provider ??
                          configuredProviders[0] ??
                          "ali",
                        upstreamModel: event.target.value,
                      },
                    }))
                  }
                  placeholder={t(
                    "settings.modelConfig.mediaModels.upstreamModelPlaceholder",
                    {
                      model: row.model,
                    },
                  )}
                  className="h-8 rounded-md border-input/80 focus-visible:border-ring/70 focus-visible:ring-1 focus-visible:ring-ring/30"
                  disabled={configuredProviders.length === 0}
                />
              )}
              <div className="flex items-center justify-end gap-1">
                {!row.mainline ? (
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    title={t(
                      "settings.modelConfig.mediaModels.editCapabilities",
                    )}
                    onClick={() => setEditingModel(row.model)}
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                ) : null}
                {!comfyOnly && !row.mainline ? (
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    className="text-muted-foreground hover:text-destructive"
                    title={t("settings.modelConfig.mediaModels.removeModel")}
                    onClick={() =>
                      setLocalMediaModels((current) => {
                        const next = { ...current };
                        delete next[row.model];
                        return next;
                      })
                    }
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                ) : null}
                {row.mainline ? (
                  <span className="px-2 text-xs text-muted-foreground">-</span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      <Dialog
        open={creatingModel || editingModel !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            setCreatingModel(false);
            setEditingModel(null);
          }
        }}
      >
        <DialogContent className="max-h-[88vh] w-[calc(100vw-2rem)] max-w-[900px] overflow-hidden p-0 sm:max-w-[900px]">
          <DialogHeader className="sr-only">
            <DialogTitle>
              {t(
                editingModel
                  ? "settings.modelConfig.mediaModels.editModelTitle"
                  : "settings.modelConfig.mediaModels.addModelTitle",
              )}
            </DialogTitle>
          </DialogHeader>
          <ScrollArea className="max-h-[88vh]">
            <LocalMediaModelEditor
              key={editingModel ?? "__new_media_model__"}
              originalModel={editingModel}
              entry={editingModel ? mediaModels[editingModel] : undefined}
              configuredProviders={configuredProviders}
              comfyOnly={comfyOnly}
              onCancel={() => {
                setCreatingModel(false);
                setEditingModel(null);
              }}
              onSave={(model, entry) => {
                setLocalMediaModels((current) => {
                  const next = { ...current };
                  if (editingModel && editingModel !== model)
                    delete next[editingModel];
                  next[model] = entry;
                  return next;
                });
                setCreatingModel(false);
                setEditingModel(null);
              }}
            />
          </ScrollArea>
        </DialogContent>
      </Dialog>

      {saveError ? (
        <p className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] leading-relaxed text-destructive">
          {saveError}
        </p>
      ) : null}

      <div className="mt-3 flex items-center justify-end gap-3">
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {configuredProviders.length > 0
            ? t("settings.modelConfig.mediaModels.saveHint")
            : t("settings.modelConfig.mediaModels.noChannelsHint")}
        </p>
        <Button
          type="button"
          size="sm"
          className="shrink-0"
          onClick={handleSave}
          disabled={
            configuredProviders.length === 0 ||
            saveProviderChannels.isPending ||
            saveMediaModels.isPending
          }
        >
          {saveProviderChannels.isPending || saveMediaModels.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : null}
          {t(
            comfyOnly
              ? "settings.modelConfig.mediaModels.saveVideo"
              : "settings.modelConfig.mediaModels.save",
          )}
        </Button>
      </div>
    </div>
  );
}

function LocalMediaModelEditor({
  originalModel,
  entry,
  configuredProviders,
  comfyOnly,
  onCancel,
  onSave,
}: {
  originalModel: string | null;
  entry?: MediaModelEntry;
  configuredProviders: readonly FeatureModelProvider[];
  comfyOnly: boolean;
  onCancel: () => void;
  onSave: (model: string, entry: MediaModelEntry) => void;
}) {
  const { t } = useTranslation();
  const initialType = entry?.mediaType === "image" ? "image" : "video";
  const [model, setModel] = useState(originalModel ?? "");
  const [label, setLabel] = useState(entry?.label ?? originalModel ?? "");
  const [mediaType, setMediaType] = useState<"image" | "video">(initialType);
  const [provider, setProvider] = useState<FeatureModelProvider>(
    entry?.provider ?? configuredProviders[0] ?? "comfyui",
  );
  const [upstreamModel, setUpstreamModel] = useState(
    entry?.upstreamModel ?? originalModel ?? "",
  );
  const [enabled, setEnabled] = useState(entry?.enabled !== false);
  const [sortOrder, setSortOrder] = useState(entry?.sortOrder ?? 100);
  const defaultConfig = {
    request: {
      endpoint:
        mediaType === "image" ? "images/generations" : "video/generations",
      parameters: [],
    },
  };
  const [configJson, setConfigJson] = useState(
    JSON.stringify(entry?.config ?? defaultConfig, null, 2),
  );
  const parsedConfig = useMemo(() => {
    try {
      const parsed = JSON.parse(configJson) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }, [configJson]);
  const setCapability = (key: string, value: unknown) => {
    if (!parsedConfig) {
      toast.error(
        t("settings.modelConfig.mediaModels.invalidCapabilitiesJson"),
      );
      return;
    }
    const next = { ...parsedConfig };
    if (value === undefined || value === null || value === "") delete next[key];
    else next[key] = value;
    setConfigJson(JSON.stringify(next, null, 2));
  };
  const stringOptions = (key: string): string[] =>
    Array.isArray(parsedConfig?.[key])
      ? (parsedConfig[key] as unknown[]).map(String)
      : [];

  const handleMediaTypeChange = (nextType: "image" | "video") => {
    setMediaType(nextType);
    try {
      const current = JSON.parse(configJson) as Record<string, unknown>;
      const request =
        current.request &&
        typeof current.request === "object" &&
        !Array.isArray(current.request)
          ? (current.request as Record<string, unknown>)
          : {};
      setConfigJson(
        JSON.stringify(
          {
            ...current,
            request: {
              ...request,
              endpoint:
                nextType === "image"
                  ? "images/generations"
                  : "video/generations",
              parameters: Array.isArray(request.parameters)
                ? request.parameters
                : [],
            },
          },
          null,
          2,
        ),
      );
    } catch {
      // Keep invalid draft text so the user can repair it before saving.
    }
  };

  const handleSave = () => {
    const cleanModel = model.trim();
    if (!cleanModel || !label.trim() || !provider) {
      toast.error(t("settings.modelConfig.mediaModels.missingModelFields"));
      return;
    }
    let config: Record<string, unknown>;
    try {
      const parsed = JSON.parse(configJson) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error();
      config = parsed as Record<string, unknown>;
      delete config[COMFY_WORKFLOW_MANAGED_CONFIG_KEY];
    } catch {
      toast.error(
        t("settings.modelConfig.mediaModels.invalidCapabilitiesJson"),
      );
      return;
    }
    onSave(cleanModel, {
      provider,
      upstreamModel: upstreamModel.trim() || cleanModel,
      mediaType,
      label: label.trim(),
      enabled,
      sortOrder,
      config,
    });
  };

  return (
    <div className="p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-foreground">
            {t(
              originalModel
                ? "settings.modelConfig.mediaModels.editModelTitle"
                : "settings.modelConfig.mediaModels.addModelTitle",
            )}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {t("settings.modelConfig.mediaModels.capabilitiesHint")}
          </p>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <FieldRow
          label={t("settings.modelConfig.mediaModels.modelId")}
          value={model}
          onChange={setModel}
          placeholder="seedance-2.0-mini"
        />
        <FieldRow
          label={t("settings.modelConfig.mediaModels.displayName")}
          value={label}
          onChange={setLabel}
          placeholder="Seedance 2.0 Mini"
        />
        <div className="grid grid-cols-[120px_1fr] items-center gap-3">
          <Label className="justify-start text-[11px] font-normal text-muted-foreground">
            {t("settings.modelConfig.mediaModels.mediaType")}
          </Label>
          <Select
            value={mediaType}
            onValueChange={(value) =>
              handleMediaTypeChange(value as "image" | "video")
            }
          >
            <SelectTrigger size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectItem value="image">
                {t("settings.modelConfig.mediaModels.types.image")}
              </SelectItem>
              <SelectItem value="video">
                {t("settings.modelConfig.mediaModels.types.video")}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-[120px_1fr] items-center gap-3">
          <Label className="justify-start text-[11px] font-normal text-muted-foreground">
            {t("settings.modelConfig.mediaModels.colProvider")}
          </Label>
          <Select
            value={provider}
            onValueChange={(value) =>
              setProvider(value as FeatureModelProvider)
            }
            disabled={comfyOnly}
          >
            <SelectTrigger size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              {configuredProviders.map((item) => (
                <SelectItem key={item} value={item}>
                  {featureProviderLabel(item)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="col-span-2">
          <FieldRow
            label={t("settings.modelConfig.mediaModels.colUpstreamModel")}
            value={upstreamModel}
            onChange={setUpstreamModel}
            placeholder={model || "upstream-model-name"}
          />
        </div>
        <div className="grid grid-cols-[120px_1fr] items-center gap-3">
          <Label className="justify-start text-[11px] font-normal text-muted-foreground">
            {t("settings.modelConfig.mediaModels.sortOrder")}
          </Label>
          <Input
            type="number"
            value={sortOrder}
            onChange={(event) => setSortOrder(Number(event.target.value) || 0)}
            className="h-8"
          />
        </div>
        <label className="flex items-center gap-2 text-xs text-foreground">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          {t("settings.modelConfig.mediaModels.enabled")}
        </label>
      </div>
      <div className="mt-3">
        <p className="text-[11px] font-medium text-foreground">
          {t("settings.modelConfig.mediaModels.commonCapabilities")}
        </p>
        <div className="mt-2 grid grid-cols-2 gap-3">
          <CatalogMultiSelectField
            label={t("settings.modelConfig.mediaModels.resolutionOptions")}
            value={stringOptions("resolutionOptions")}
            onChange={(value) => setCapability("resolutionOptions", value)}
            options={
              mediaType === "image"
                ? ["1K", "2K", "3K", "4K", "8K", "1024x1024", "2048x2048"]
                : ["480p", "720p", "1080p", "2K", "4K"]
            }
          />
          <CatalogMultiSelectField
            label={t("settings.modelConfig.mediaModels.ratioOptions")}
            value={stringOptions("ratioOptions")}
            onChange={(value) => setCapability("ratioOptions", value)}
            options={[
              "1:1",
              "16:9",
              "9:16",
              "4:3",
              "3:4",
              "3:2",
              "2:3",
              "21:9",
              "adaptive",
            ]}
          />
          {mediaType === "image" ? (
            <CatalogListField
              label={t("settings.modelConfig.mediaModels.qualityOptions")}
              value={stringOptions("qualityOptions")}
              onChange={(value) => setCapability("qualityOptions", value)}
              placeholder="low, medium, high"
            />
          ) : (
            <>
              <CatalogNumberField
                label={t("settings.modelConfig.mediaModels.minDuration")}
                value={parsedConfig?.minDuration}
                onChange={(value) => setCapability("minDuration", value)}
              />
              <CatalogNumberField
                label={t("settings.modelConfig.mediaModels.maxDuration")}
                value={parsedConfig?.maxDuration}
                onChange={(value) => setCapability("maxDuration", value)}
              />
              <CatalogNumberField
                label={t("settings.modelConfig.mediaModels.referenceImageMax")}
                value={parsedConfig?.referenceImageMax}
                min={0}
                onChange={(value) => setCapability("referenceImageMax", value)}
              />
              <CatalogNumberField
                label={t("settings.modelConfig.mediaModels.referenceVideoMax")}
                value={parsedConfig?.referenceVideoMax}
                min={0}
                onChange={(value) => setCapability("referenceVideoMax", value)}
              />
              <CatalogNumberField
                label={t("settings.modelConfig.mediaModels.referenceAudioMax")}
                value={parsedConfig?.referenceAudioMax}
                min={0}
                onChange={(value) => setCapability("referenceAudioMax", value)}
              />
              <CatalogNumberField
                label={t("settings.modelConfig.mediaModels.referenceFileMax")}
                value={parsedConfig?.referenceFileMax}
                min={0}
                max={1}
                onChange={(value) => setCapability("referenceFileMax", value)}
              />
              <CatalogNumberField
                label={t("settings.modelConfig.mediaModels.referenceLinkMax")}
                value={parsedConfig?.referenceLinkMax}
                min={0}
                max={1}
                onChange={(value) => setCapability("referenceLinkMax", value)}
              />
              <CatalogListField
                label={t("settings.modelConfig.mediaModels.referenceFileTypes")}
                value={stringOptions("referenceFileTypes")}
                onChange={(value) => setCapability("referenceFileTypes", value)}
                placeholder="pdf, docx, xlsx, pptx, txt, md"
              />
              {[
                "referenceAudioMinSeconds",
                "referenceAudioMaxSeconds",
                "referenceAudioTotalMinSeconds",
                "referenceAudioTotalMaxSeconds",
                "referenceVideoMinSeconds",
                "referenceVideoMaxSeconds",
                "referenceVideoTotalMinSeconds",
                "referenceVideoTotalMaxSeconds",
              ].map((field) => (
                <CatalogNumberField
                  key={field}
                  label={t(`settings.modelConfig.mediaModels.${field}`)}
                  value={parsedConfig?.[field]}
                  min={0.1}
                  step={0.1}
                  onChange={(value) => setCapability(field, value)}
                />
              ))}
              <label className="flex items-center gap-2 text-xs text-foreground">
                <input
                  type="checkbox"
                  checked={parsedConfig?.humanReview === true}
                  onChange={(event) =>
                    setCapability("humanReview", event.target.checked)
                  }
                />
                {t("settings.modelConfig.mediaModels.humanReview")}
              </label>
              <div className="col-span-2">
                <p className="mb-2 text-[11px] text-muted-foreground">
                  {t("settings.modelConfig.mediaModels.supportedModes")}
                </p>
                <div className="grid grid-cols-3 gap-2">
                  {/* 左边是后端目录里的模式值，右边只是展示名，和视频节点的页签共用词条。 */}
                  {[
                    ["text_to_video", "node.videoNode.tabs.textToVideo"],
                    ["first_frame", "node.videoNode.tabs.firstFrame"],
                    ["first_last_frame", "node.videoNode.tabs.firstLastFrame"],
                    ["image_to_video", "node.videoNode.tabs.imageToVideo"],
                    ["image_reference", "node.videoNode.tabs.imageReference"],
                    ["all_reference", "node.videoNode.tabs.allReference"],
                    ["video_edit", "node.videoNode.tabs.videoEdit"],
                  ].map(([value, labelKey]) => {
                    const selected = stringOptions("supportedModes");
                    return (
                      <label
                        key={value}
                        className="flex items-center gap-2 text-xs text-foreground"
                      >
                        <input
                          type="checkbox"
                          checked={selected.includes(value)}
                          onChange={(event) =>
                            setCapability(
                              "supportedModes",
                              event.target.checked
                                ? [...selected, value]
                                : selected.filter((item) => item !== value),
                            )
                          }
                        />
                        {t(labelKey)}
                      </label>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
      <div className="mt-3 border-t border-border/60 pt-3">
        <Label className="text-[11px] font-normal text-muted-foreground">
          {t("settings.modelConfig.mediaModels.capabilitiesJson")}
        </Label>
        <Textarea
          value={configJson}
          onChange={(event) => setConfigJson(event.target.value)}
          spellCheck={false}
          className="mt-1 h-56 resize-y font-mono text-[11px]"
        />
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button type="button" size="sm" onClick={handleSave}>
          {t("settings.modelConfig.mediaModels.applyModelEdit")}
        </Button>
      </div>
    </div>
  );
}

function CatalogListField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string[];
  onChange: (value: string[]) => void;
  placeholder: string;
}) {
  const normalized = value.join(", ");
  const [draft, setDraft] = useState(normalized);
  useEffect(() => setDraft(normalized), [normalized]);
  return (
    <div>
      <Label className="text-[11px] font-normal text-muted-foreground">
        {label}
      </Label>
      <Input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() =>
          onChange([
            ...new Set(
              draft
                .split(/[,，]/)
                .map((item) => item.trim())
                .filter(Boolean),
            ),
          ])
        }
        placeholder={placeholder}
        className="mt-1 h-8"
      />
    </div>
  );
}

function CatalogMultiSelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string[];
  options: readonly string[];
  onChange: (value: string[]) => void;
}) {
  const { t } = useTranslation();
  const [customValue, setCustomValue] = useState("");
  const choices = [
    ...options,
    ...value.filter((item) => !options.includes(item)),
  ];
  const toggle = (option: string, selected: boolean) => {
    onChange(
      selected
        ? [...new Set([...value, option])]
        : value.filter((item) => item !== option),
    );
  };
  const addCustomValues = () => {
    const additions = customValue
      .split(/[,，]/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (additions.length === 0) return;
    onChange([...new Set([...value, ...additions])]);
    setCustomValue("");
  };

  return (
    <div>
      <Label className="text-[11px] font-normal text-muted-foreground">
        {label}
      </Label>
      <div className="mt-1 rounded-md border border-input/80 bg-background/30 p-2">
        <div className="flex flex-wrap gap-x-3 gap-y-2">
          {choices.map((option) => (
            <label
              key={option}
              className="flex items-center gap-1.5 text-xs text-foreground"
            >
              <input
                type="checkbox"
                checked={value.includes(option)}
                onChange={(event) => toggle(option, event.target.checked)}
              />
              <span>{option}</span>
            </label>
          ))}
        </div>
        <div className="mt-2 flex gap-2 border-t border-border/60 pt-2">
          <Input
            value={customValue}
            onChange={(event) => setCustomValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addCustomValues();
              }
            }}
            placeholder={t(
              "settings.modelConfig.mediaModels.customOptionPlaceholder",
            )}
            className="h-7"
          />
          <Button
            type="button"
            size="icon-sm"
            variant="outline"
            title={t("settings.modelConfig.mediaModels.addCustomOption")}
            onClick={addCustomValues}
            disabled={!customValue.trim()}
          >
            <Plus className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function CatalogNumberField({
  label,
  value,
  min = 1,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  value: unknown;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number | undefined) => void;
}) {
  return (
    <div>
      <Label className="text-[11px] font-normal text-muted-foreground">
        {label}
      </Label>
      <Input
        type="number"
        min={min}
        max={max}
        step={step}
        value={typeof value === "number" ? value : ""}
        onChange={(event) =>
          onChange(event.target.value ? Number(event.target.value) : undefined)
        }
        className="mt-1 h-8"
      />
    </div>
  );
}

function ProviderChannelsBlock({
  savedProviderChannels,
  newApiBaseUrl,
  database,
  channelTypes,
  channelTypesLoading,
  allowedProviders,
  excludedProviders,
}: {
  savedProviderChannels: SavedProviderChannelConfig[];
  newApiBaseUrl: string;
  database: NewApiDatabaseConfigInput | undefined;
  channelTypes: NewApiChannelType[];
  channelTypesLoading: boolean;
  allowedProviders?: readonly string[];
  excludedProviders?: readonly string[];
}) {
  const { t } = useTranslation();
  const providerChannels = useSettingsStore(
    (s) => s.featureModelConfig.providerChannels,
  );
  const addFeatureProviderChannel = useSettingsStore(
    (s) => s.addFeatureProviderChannel,
  );
  const updateFeatureProviderChannel = useSettingsStore(
    (s) => s.updateFeatureProviderChannel,
  );
  const saveProviderChannels = useSaveProviderChannels();
  const channelTypeByProvider = useMemo(
    () => new Map(channelTypes.map((item) => [item.provider, item])),
    [channelTypes],
  );

  const allowedProviderSet = useMemo(
    () => (allowedProviders ? new Set(allowedProviders) : null),
    [allowedProviders],
  );
  const excludedProviderSet = useMemo(
    () => new Set(excludedProviders ?? []),
    [excludedProviders],
  );
  const configuredProviders = useMemo(
    () =>
      Object.keys(providerChannels)
        .filter(
          (provider) => !allowedProviderSet || allowedProviderSet.has(provider),
        )
        .filter((provider) => !excludedProviderSet.has(provider))
        .sort(),
    [allowedProviderSet, excludedProviderSet, providerChannels],
  );
  const providerOptions =
    channelTypes.length > 0
      ? channelTypes.filter(
          (item) =>
            item.status === 1 &&
            (!allowedProviderSet || allowedProviderSet.has(item.provider)) &&
            !excludedProviderSet.has(item.provider),
        )
      : FEATURE_MODEL_PROVIDERS.filter(
          (provider) =>
            (!allowedProviderSet || allowedProviderSet.has(provider)) &&
            !excludedProviderSet.has(provider),
        ).map((provider) => ({
          provider,
          name: featureProviderLabel(provider),
        }));
  const availableProviders = providerOptions.filter(
    (item) => !providerChannels[item.provider],
  );
  const savedChannelByProvider = useMemo(() => {
    return new Map(
      savedProviderChannels.map((channel) => [channel.provider, channel]),
    );
  }, [savedProviderChannels]);
  const [selectedProvider, setSelectedProvider] =
    useState<FeatureModelProvider>(
      availableProviders[0]?.provider ??
        allowedProviders?.[0] ??
        FEATURE_MODEL_PROVIDERS[0],
    );

  useEffect(() => {
    if (
      !availableProviders.some((item) => item.provider === selectedProvider) &&
      availableProviders[0]
    ) {
      setSelectedProvider(availableProviders[0].provider);
    }
  }, [availableProviders, selectedProvider]);

  const handleAdd = () => {
    if (!availableProviders.some((item) => item.provider === selectedProvider))
      return;
    addFeatureProviderChannel(selectedProvider);
    const channelType = channelTypeByProvider.get(selectedProvider);
    if (channelType?.requiresBaseUrl && channelType.defaultBaseUrl) {
      updateFeatureProviderChannel(selectedProvider, {
        baseUrl: channelType.defaultBaseUrl,
      });
    }
  };

  const handleSaveChannels = () => {
    if (configuredProviders.length === 0) {
      toast.error(t("settings.modelConfig.featureModels.noChannels"));
      return;
    }
    const channelsToSave = configuredProviders
      .filter((provider) => {
        if (provider === "comfyui") return true;
        if ((providerChannels[provider]?.upstreamKey ?? "").trim()) return true;
        return Boolean(savedChannelByProvider.get(provider)?.configured);
      })
      .map((provider) => ({
        provider,
        type:
          channelTypeByProvider.get(provider)?.type ||
          savedChannelByProvider.get(provider)?.type,
        upstreamKey:
          (providerChannels[provider]?.upstreamKey ?? "").trim() || undefined,
        baseUrl: (providerChannels[provider]?.baseUrl ?? "").trim(),
        priority: providerChannels[provider]?.priority ?? 0,
        settings: normalizeProviderChannelSettings(
          provider,
          providerChannels[provider]?.settings ?? {},
        ),
      }));
    if (channelsToSave.length === 0) {
      toast.error(
        t("settings.modelConfig.featureModels.missingKeys", {
          providers: configuredProviders
            .map((provider) =>
              featureProviderLabel(provider, channelTypeByProvider),
            )
            .join("、"),
        }),
      );
      return;
    }
    saveProviderChannels.mutate(
      {
        preserveUnmentioned: Boolean(allowedProviderSet),
        channels: channelsToSave,
      },
      {
        onSuccess: (res) => {
          if (!res.ok) {
            toast.error(
              getResponseErrorMessage(
                res,
                t("settings.modelConfig.requestFailed"),
              ),
            );
            return;
          }
          for (const { provider } of channelsToSave) {
            if ((providerChannels[provider]?.upstreamKey ?? "").trim()) {
              useSettingsStore
                .getState()
                .clearFeatureProviderUpstreamKey(provider);
            }
          }
          toast.success(t("settings.modelConfig.featureModels.channelsSaved"));
        },
        onError: () => {
          toast.error(t("settings.modelConfig.requestFailed"));
        },
      },
    );
  };

  return (
    <div className="mt-5 rounded-md border border-border/70 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="text-xs font-medium text-foreground">
            {t("settings.modelConfig.featureModels.channelsTitle")}
          </h4>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            {t("settings.modelConfig.featureModels.channelsDescription")}
          </p>
        </div>
        <div className="flex min-w-[260px] items-center gap-2">
          <Select
            value={selectedProvider}
            onValueChange={(value) =>
              setSelectedProvider(value as FeatureModelProvider)
            }
            disabled={channelTypesLoading || availableProviders.length === 0}
          >
            <SelectTrigger size="sm" className="min-w-[170px] flex-1">
              <SelectValue>
                {(value: string) =>
                  featureProviderLabel(value, channelTypeByProvider)
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              {availableProviders.map((item) => (
                <SelectItem key={item.provider} value={item.provider}>
                  {item.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="shrink-0"
            onClick={handleAdd}
            disabled={channelTypesLoading || availableProviders.length === 0}
          >
            <Plus className="size-3.5" />
            {t("settings.modelConfig.featureModels.addChannel")}
          </Button>
        </div>
      </div>

      {configuredProviders.length > 0 ? (
        <>
          <div className="mt-3 space-y-2.5">
            {configuredProviders.map((provider) => (
              <ProviderChannelRow
                key={provider}
                provider={provider}
                channelType={channelTypeByProvider.get(provider)}
                savedChannel={savedChannelByProvider.get(provider)}
                newApiBaseUrl={newApiBaseUrl}
                database={database}
              />
            ))}
          </div>
          <div className="mt-3 flex items-center justify-end gap-3">
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {t("settings.modelConfig.featureModels.channelsSaveHint")}
            </p>
            <Button
              type="button"
              size="sm"
              onClick={handleSaveChannels}
              disabled={saveProviderChannels.isPending}
            >
              {saveProviderChannels.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : null}
              {t("settings.modelConfig.featureModels.saveChannels")}
            </Button>
          </div>
        </>
      ) : (
        <p className="mt-3 rounded-md border border-dashed border-border/70 px-3 py-2 text-[11px] text-muted-foreground">
          {t("settings.modelConfig.featureModels.noChannelsHint")}
        </p>
      )}
    </div>
  );
}

function ProviderChannelRow({
  provider,
  channelType,
  savedChannel,
  newApiBaseUrl,
  database,
}: {
  provider: FeatureModelProvider;
  channelType: NewApiChannelType | undefined;
  savedChannel: SavedProviderChannelConfig | undefined;
  newApiBaseUrl: string;
  database: NewApiDatabaseConfigInput | undefined;
}) {
  const { t } = useTranslation();
  const channel = useSettingsStore(
    (s) => s.featureModelConfig.providerChannels[provider],
  );
  const updateFeatureProviderChannel = useSettingsStore(
    (s) => s.updateFeatureProviderChannel,
  );
  const removeFeatureProviderChannel = useSettingsStore(
    (s) => s.removeFeatureProviderChannel,
  );
  const clearFeatureProviderUpstreamKey = useSettingsStore(
    (s) => s.clearFeatureProviderUpstreamKey,
  );
  const syncProviderChannel = useSyncProviderChannel();
  const clearComfyUIConfig = useClearComfyUIConfig();
  const [revealed, setRevealed] = useState(false);
  const upstreamKeyValue = channel?.upstreamKey ?? "";
  const savedKeyPreview = savedChannel?.configured
    ? savedChannel.upstreamKeyPreview
    : "";
  const upstreamPlaceholder = savedKeyPreview || "sk-...";
  const isComfyUI = provider === "comfyui";
  const hasComfyUIConfig = isComfyUI && savedChannel?.configured === true;
  useEffect(() => {
    if (!upstreamKeyValue) setRevealed(false);
  }, [upstreamKeyValue]);
  const handleSync = async () => {
    if (!newApiBaseUrl.trim()) {
      toast.error(t("settings.modelConfig.featureModels.missingBaseUrl"));
      return;
    }
    const upstreamKey = upstreamKeyValue.trim();
    if (!isComfyUI && !upstreamKey && !savedChannel?.configured) {
      toast.error(
        t("settings.modelConfig.featureModels.missingKeys", {
          providers: channelType?.name || featureProviderLabel(provider),
        }),
      );
      return;
    }
    try {
      const res = await syncProviderChannel.mutateAsync({
        newApiBaseUrl: newApiBaseUrl.trim(),
        ...(database ? { database } : {}),
        provider,
        ...(upstreamKey ? { upstreamKey } : {}),
        baseUrl: (channel?.baseUrl ?? "").trim(),
      });
      if (res.ok !== true) {
        toast.error(
          getResponseErrorMessage(res, t("settings.modelConfig.requestFailed")),
        );
        return;
      }
      if (upstreamKey) {
        clearFeatureProviderUpstreamKey(provider);
        setRevealed(false);
      }
      toast.success(t("settings.modelConfig.featureModels.channelSynced"));
    } catch (error) {
      toast.error(
        await getRequestErrorMessage(
          error,
          t("settings.modelConfig.requestFailed"),
        ),
      );
    }
  };
  const handleClearComfyUI = async () => {
    const confirmed = await confirmDialog({
      title: t("settings.modelConfig.featureModels.clearComfyTitle"),
      description: t("settings.modelConfig.featureModels.clearComfyConfirm"),
      confirmText: t("settings.modelConfig.featureModels.clearComfy"),
      confirmVariant: "destructive",
    });
    if (!confirmed) return;
    try {
      const response = await clearComfyUIConfig.mutateAsync();
      if (response.ok !== true) {
        toast.error(
          getResponseErrorMessage(
            response,
            t("settings.modelConfig.requestFailed"),
          ),
        );
        return;
      }
      removeFeatureProviderChannel("comfyui");
      const currentMediaModels =
        useSettingsStore.getState().featureModelConfig.mediaModels ?? {};
      useSettingsStore
        .getState()
        .setMediaModels(
          Object.fromEntries(
            Object.entries(currentMediaModels).filter(
              ([, entry]) => entry.provider !== "comfyui",
            ),
          ),
        );
      toast.success(t("settings.modelConfig.featureModels.comfyCleared"));
    } catch (error) {
      toast.error(
        await getRequestErrorMessage(
          error,
          t("settings.modelConfig.requestFailed"),
        ),
      );
    }
  };

  return (
    <div className="rounded-md border border-border/60 p-2.5">
      <div className="grid gap-2 sm:grid-cols-[130px_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
        <div>
          <Label className="justify-start text-[11px] font-normal text-muted-foreground">
            {t("settings.modelConfig.featureModels.channelProvider")}
          </Label>
          <div className="mt-1.5 h-9 rounded-md border border-border/70 bg-white/[0.03] px-3 py-2 text-xs text-foreground">
            {channelType?.name || featureProviderLabel(provider)}
          </div>
        </div>
        <div>
          <Label className="justify-start text-[11px] font-normal text-muted-foreground">
            {t("settings.modelConfig.featureModels.upstreamKey")}
          </Label>
          <div className="relative mt-1.5">
            <Input
              name={`provider-${provider}-upstream-api-key`}
              autoComplete="new-password"
              data-1p-ignore="true"
              data-lpignore="true"
              type={revealed ? "text" : "password"}
              value={upstreamKeyValue}
              onChange={(e) =>
                updateFeatureProviderChannel(provider, {
                  upstreamKey: e.target.value,
                })
              }
              placeholder={
                savedKeyPreview
                  ? t("settings.secretSavedPlaceholder", {
                      preview: savedKeyPreview,
                    })
                  : upstreamPlaceholder
              }
              autoCapitalize="none"
              spellCheck={false}
              className={cn(
                "h-9 rounded-md border-input/80 focus-visible:border-ring/70 focus-visible:ring-1 focus-visible:ring-ring/30",
                upstreamKeyValue ? "pr-9" : savedKeyPreview ? "pr-16" : "",
              )}
            />
            {upstreamKeyValue ? (
              <button
                type="button"
                onClick={() => setRevealed((r) => !r)}
                aria-label={
                  revealed
                    ? t("settings.mediaStorage.hideSecret")
                    : t("settings.mediaStorage.showSecret")
                }
                className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
              >
                {revealed ? (
                  <EyeOff className="size-4" />
                ) : (
                  <Eye className="size-4" />
                )}
              </button>
            ) : savedKeyPreview ? (
              <span className="absolute top-1/2 right-2 -translate-y-1/2 rounded bg-emerald-400/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">
                {t("settings.secretSavedBadge")}
              </span>
            ) : null}
          </div>
        </div>
        <div>
          <Label className="justify-start text-[11px] font-normal text-muted-foreground">
            {t("settings.modelConfig.featureModels.baseUrlOverride")}
          </Label>
          <Input
            value={channel?.baseUrl ?? ""}
            onChange={(e) =>
              updateFeatureProviderChannel(provider, {
                baseUrl: e.target.value,
              })
            }
            placeholder={
              channelType?.defaultBaseUrl ||
              t("settings.modelConfig.featureModels.baseUrlPlaceholder")
            }
            disabled={channelType?.supportsBaseUrlOverride === false}
            className="mt-1.5 h-9 rounded-md border-input/80 focus-visible:border-ring/70 focus-visible:ring-1 focus-visible:ring-ring/30"
          />
        </div>
        <div className="flex items-center justify-end gap-1.5 sm:self-end">
          {!isComfyUI ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-9 whitespace-nowrap px-2 text-[11px]"
              onClick={handleSync}
              disabled={syncProviderChannel.isPending}
              title={t("settings.modelConfig.featureModels.syncChannelHint")}
            >
              {syncProviderChannel.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RotateCw className="size-3.5" />
              )}
              {t("settings.modelConfig.featureModels.syncChannel")}
            </Button>
          ) : null}
          {hasComfyUIConfig ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-9 whitespace-nowrap text-destructive hover:text-destructive"
              onClick={() => void handleClearComfyUI()}
              disabled={clearComfyUIConfig.isPending}
            >
              {clearComfyUIConfig.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Trash2 className="size-3.5" />
              )}
              {t("settings.modelConfig.featureModels.clearComfy")}
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-destructive"
              onClick={() => removeFeatureProviderChannel(provider)}
              title={t("settings.modelConfig.featureModels.removeChannel")}
            >
              <Trash2 className="size-4" />
            </Button>
          )}
        </div>
      </div>
      {isComfyUI ? (
        <ComfyUIWorkflowsEditor
          settings={channel?.settings ?? {}}
          onChange={(settings) =>
            updateFeatureProviderChannel(provider, { settings })
          }
        />
      ) : null}
    </div>
  );
}

function readComfyUIWorkflows(
  settings: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  const comfyui = settings.comfyui;
  if (!comfyui || typeof comfyui !== "object" || Array.isArray(comfyui))
    return {};
  const config = comfyui as Record<string, unknown>;
  const routes = config.workflow_routes;
  if (Array.isArray(routes)) {
    return Object.fromEntries(
      routes.flatMap((route) => {
        if (!route || typeof route !== "object" || Array.isArray(route))
          return [];
        const item = route as Record<string, unknown>;
        const id = typeof item.id === "string" ? item.id.trim() : "";
        const workflow = item.workflow;
        if (
          !id ||
          !workflow ||
          typeof workflow !== "object" ||
          Array.isArray(workflow)
        )
          return [];
        return [[id, workflow as Record<string, unknown>]];
      }),
    );
  }
  const workflows = config.workflow_by_model;
  if (!workflows || typeof workflows !== "object" || Array.isArray(workflows))
    return {};
  return Object.fromEntries(
    Object.entries(workflows).filter(
      (entry): entry is [string, Record<string, unknown>] =>
        Boolean(entry[0]) &&
        Boolean(entry[1]) &&
        typeof entry[1] === "object" &&
        !Array.isArray(entry[1]),
    ),
  );
}

function readComfyUIModelName(settings: Record<string, unknown>): string {
  const comfyui = settings.comfyui;
  if (!comfyui || typeof comfyui !== "object" || Array.isArray(comfyui))
    return "";
  const config = comfyui as Record<string, unknown>;
  if (typeof config.model_name === "string" && config.model_name.trim()) {
    return config.model_name.trim();
  }
  if (Array.isArray(config.workflow_routes)) {
    for (const route of config.workflow_routes) {
      if (!route || typeof route !== "object" || Array.isArray(route)) continue;
      const match = (route as Record<string, unknown>).match;
      if (!match || typeof match !== "object" || Array.isArray(match)) continue;
      const models = (match as Record<string, unknown>).models;
      if (Array.isArray(models) && typeof models[0] === "string") {
        const model = models[0].trim();
        if (model) return model;
      }
    }
  }
  const legacyModels = Object.keys(readComfyUIWorkflows(settings));
  if (legacyModels.length === 1) return legacyModels[0];
  if (
    legacyModels.length > 1 &&
    legacyModels.every((model) => /^minimax[_-]h3(?:[_-]|$)/i.test(model))
  ) {
    return "MiniMax-H3-local";
  }
  return legacyModels[0] ?? "";
}

function buildComfyUIWorkflowRoutes(
  workflows: Record<string, Record<string, unknown>>,
): Record<string, unknown>[] {
  return Object.entries(workflows).map(([id, workflow]) => ({
    id,
    match: {},
    workflow,
  }));
}

function normalizeProviderChannelSettings(
  provider: string,
  settings: Record<string, unknown>,
): Record<string, unknown> {
  if (provider !== "comfyui") return settings;
  const comfyui =
    settings.comfyui &&
    typeof settings.comfyui === "object" &&
    !Array.isArray(settings.comfyui)
      ? (settings.comfyui as Record<string, unknown>)
      : {};
  if (Array.isArray(comfyui.workflow_routes)) return settings;
  const workflows = readComfyUIWorkflows(settings);
  const workflowIds = Object.keys(workflows);
  const isLegacyH3Group =
    workflowIds.length > 1 &&
    workflowIds.every((id) => /^minimax[_-]h3(?:[_-]|$)/i.test(id));
  if (workflowIds.length !== 1 && !isLegacyH3Group) return settings;
  const model = readComfyUIModelName(settings);
  if (!model) return settings;
  const normalized = { ...comfyui };
  delete normalized.workflow_by_model;
  delete normalized.workflow;
  normalized.model_name = model;
  normalized.workflow_routes = buildComfyUIWorkflowRoutes(workflows);
  return { ...settings, comfyui: normalized };
}

function ComfyUIWorkflowsEditor({
  settings,
  onChange,
}: {
  settings: Record<string, unknown>;
  onChange: (settings: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation();
  const workflows = readComfyUIWorkflows(settings);
  const model = readComfyUIModelName(settings);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [expandedWorkflows, setExpandedWorkflows] = useState<Set<string>>(
    () => new Set(),
  );

  const writeConfig = (
    nextModel: string,
    nextWorkflows: Record<string, Record<string, unknown>>,
  ) => {
    const existingComfyUI =
      settings.comfyui &&
      typeof settings.comfyui === "object" &&
      !Array.isArray(settings.comfyui)
        ? (settings.comfyui as Record<string, unknown>)
        : {};
    const nextComfyUI = { ...existingComfyUI };
    delete nextComfyUI.workflow_by_model;
    delete nextComfyUI.workflow;
    nextComfyUI.model_name = nextModel;
    nextComfyUI.workflow_routes = buildComfyUIWorkflowRoutes(nextWorkflows);
    onChange({
      ...settings,
      comfyui: nextComfyUI,
    });
  };

  const addWorkflow = () => {
    let index = Object.keys(workflows).length + 1;
    let workflowId = `workflow-${index}`;
    while (workflows[workflowId]) workflowId = `workflow-${++index}`;
    writeConfig(model, { ...workflows, [workflowId]: {} });
    setDrafts((current) => ({ ...current, [workflowId]: "{}" }));
  };

  const renameWorkflow = (previous: string, nextValue: string) => {
    const next = nextValue.trim();
    if (!next || next === previous) return;
    if (workflows[next]) {
      toast.error(
        t("settings.modelConfig.featureModels.comfyDuplicateWorkflow"),
      );
      return;
    }
    const renamed: Record<string, Record<string, unknown>> = {};
    for (const [model, workflow] of Object.entries(workflows)) {
      renamed[model === previous ? next : model] = workflow;
    }
    writeConfig(model, renamed);
    setDrafts((current) => {
      const updated = {
        ...current,
        [next]:
          current[previous] ?? JSON.stringify(workflows[previous], null, 2),
      };
      delete updated[previous];
      return updated;
    });
  };

  const commitWorkflow = (workflowId: string, text: string) => {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error();
      writeConfig(model, {
        ...workflows,
        [workflowId]: parsed as Record<string, unknown>,
      });
    } catch {
      toast.error(t("settings.modelConfig.featureModels.comfyInvalidWorkflow"));
    }
  };

  return (
    <div className="mt-3 border-t border-border/60 pt-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-foreground">
            {t("settings.modelConfig.featureModels.comfyWorkflows")}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("settings.modelConfig.featureModels.comfyWorkflowHint")}
          </p>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={addWorkflow}>
          <Plus className="size-3.5" />
          {t("settings.modelConfig.featureModels.comfyAddWorkflow")}
        </Button>
      </div>
      <div className="mt-3">
        <Label className="text-xs text-muted-foreground">
          {t("settings.modelConfig.featureModels.comfyModelName")}
        </Label>
        <Input
          value={model}
          onChange={(event) => writeConfig(event.target.value, workflows)}
          placeholder={t(
            "settings.modelConfig.featureModels.comfyModelPlaceholder",
          )}
          className="mt-1 h-8"
        />
      </div>
      <div className="mt-3 space-y-3">
        {Object.entries(workflows).map(([workflowId, workflow]) => {
          const text = drafts[workflowId] ?? JSON.stringify(workflow, null, 2);
          const isExpanded = expandedWorkflows.has(workflowId);
          return (
            <div
              key={workflowId}
              className="rounded-md border border-border/60 p-2.5"
            >
              <Label className="text-xs text-muted-foreground">
                {t("settings.modelConfig.featureModels.comfyWorkflowId")}
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  defaultValue={workflowId}
                  onBlur={(event) =>
                    renameWorkflow(workflowId, event.target.value)
                  }
                  placeholder={t(
                    "settings.modelConfig.featureModels.comfyWorkflowIdPlaceholder",
                  )}
                  className="mt-1 h-8"
                />
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => {
                    const next = { ...workflows };
                    delete next[workflowId];
                    writeConfig(model, next);
                  }}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
              <div className="mt-2 flex items-center justify-between gap-2">
                <Label className="text-xs text-muted-foreground">
                  {t("settings.modelConfig.featureModels.comfyWorkflowJson")}
                </Label>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-[10px] text-muted-foreground"
                  onClick={() =>
                    setExpandedWorkflows((current) => {
                      const next = new Set(current);
                      if (next.has(workflowId)) next.delete(workflowId);
                      else next.add(workflowId);
                      return next;
                    })
                  }
                >
                  {isExpanded ? (
                    <Minimize2 className="size-3.5" />
                  ) : (
                    <Maximize2 className="size-3.5" />
                  )}
                  {t(
                    isExpanded
                      ? "settings.modelConfig.featureModels.comfyCollapseWorkflow"
                      : "settings.modelConfig.featureModels.comfyExpandWorkflow",
                  )}
                </Button>
              </div>
              <Textarea
                value={text}
                onChange={(event) =>
                  setDrafts((current) => ({
                    ...current,
                    [workflowId]: event.target.value,
                  }))
                }
                onBlur={(event) =>
                  commitWorkflow(workflowId, event.target.value)
                }
                spellCheck={false}
                className={cn(
                  "mt-1 resize-none font-mono text-xs transition-[height] duration-200",
                  isExpanded ? "h-[60vh] min-h-80" : "h-44",
                )}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FeatureModelCapabilitySection({
  title,
  hint,
  groups,
  newApiBaseUrl,
  database,
  configuredProviders,
  providerChannels,
  savedChannelByProvider,
}: {
  title: string;
  hint?: string;
  groups: readonly FeatureModelGroup[];
  newApiBaseUrl: string;
  database: NewApiDatabaseConfigInput | undefined;
  configuredProviders: readonly FeatureModelProvider[];
  providerChannels: Record<string, { upstreamKey: string; baseUrl: string }>;
  savedChannelByProvider: Map<string, SavedProviderChannelConfig>;
}) {
  const { t } = useTranslation();
  const [bulkProvider, setBulkProvider] = useState<FeatureModelProvider | "">(
    configuredProviders[0] ?? "",
  );
  const [bulkModel, setBulkModel] = useState("");
  const updateFeatureModel = useSettingsStore((s) => s.updateFeatureModel);
  const featureCount = useMemo(
    () => groups.reduce((total, group) => total + group.features.length, 0),
    [groups],
  );

  useEffect(() => {
    if (!bulkProvider || !configuredProviders.includes(bulkProvider)) {
      setBulkProvider(configuredProviders[0] ?? "");
    }
  }, [bulkProvider, configuredProviders]);

  const handleApplyBulk = () => {
    const provider = bulkProvider;
    const model = bulkModel.trim();
    if (!provider) {
      toast.error(t("settings.modelConfig.featureModels.noChannels"));
      return;
    }
    if (!model) {
      toast.error(t("settings.modelConfig.featureModels.bulkMissingModel"));
      return;
    }
    for (const group of groups) {
      for (const feature of group.features) {
        updateFeatureModel(feature.id, { provider, model });
      }
    }
    toast.success(
      t("settings.modelConfig.featureModels.bulkApplied", {
        count: featureCount,
      }),
    );
  };

  return (
    <div className="mt-4">
      <h5 className="text-[11px] font-medium text-foreground">{title}</h5>
      {hint ? (
        <p className="mt-1 text-[11px] leading-relaxed text-amber-300/80">
          {hint}
        </p>
      ) : null}
      <div className="mt-2 grid grid-cols-[150px_minmax(0,1fr)_auto] items-center gap-2 rounded-md border border-border/70 px-3 py-2">
        <Select
          value={bulkProvider}
          onValueChange={(value) =>
            setBulkProvider(value as FeatureModelProvider)
          }
          disabled={configuredProviders.length === 0}
        >
          <SelectTrigger size="sm" className="w-full">
            <SelectValue
              placeholder={t(
                "settings.modelConfig.featureModels.noChannelsShort",
              )}
            >
              {(value: string) => featureProviderLabel(value)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            {configuredProviders.map((provider) => (
              <SelectItem key={provider} value={provider}>
                {featureProviderLabel(provider)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          value={bulkModel}
          onChange={(event) => setBulkModel(event.target.value)}
          placeholder={t(
            "settings.modelConfig.featureModels.bulkModelPlaceholder",
          )}
          className="h-8 rounded-md border-input/80 focus-visible:border-ring/70 focus-visible:ring-1 focus-visible:ring-ring/30"
          disabled={configuredProviders.length === 0}
        />
        <Button
          type="button"
          size="sm"
          className="shrink-0"
          onClick={handleApplyBulk}
          disabled={configuredProviders.length === 0}
        >
          {t("settings.modelConfig.featureModels.applyToAll")}
        </Button>
      </div>

      {/* 表头：功能 / 供应商 / 上游模型名（与下方行栅格对齐） */}
      <div
        className={cn(
          FEATURE_ROW_GRID,
          "mt-2 px-3 text-[11px] font-medium tracking-wide text-muted-foreground uppercase",
        )}
      >
        <span>{t("settings.modelConfig.featureModels.colFeature")}</span>
        <span>{t("settings.modelConfig.featureModels.colProvider")}</span>
        <span>{t("settings.modelConfig.featureModels.colModel")}</span>
      </div>

      <div className="mt-2 space-y-2">
        {groups.map((group) => (
          <FeatureModelGroupBlock
            key={group.key}
            groupKey={group.key}
            features={group.features}
            newApiBaseUrl={newApiBaseUrl}
            database={database}
            configuredProviders={configuredProviders}
            providerChannels={providerChannels}
            savedChannelByProvider={savedChannelByProvider}
          />
        ))}
      </div>
    </div>
  );
}

function FeatureModelGroupBlock({
  groupKey,
  features,
  newApiBaseUrl,
  database,
  configuredProviders,
  providerChannels,
  savedChannelByProvider,
}: {
  groupKey: string;
  features: readonly FeatureModelDef[];
  newApiBaseUrl: string;
  database: NewApiDatabaseConfigInput | undefined;
  configuredProviders: readonly FeatureModelProvider[];
  providerChannels: Record<string, { upstreamKey: string; baseUrl: string }>;
  savedChannelByProvider: Map<string, SavedProviderChannelConfig>;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-md border border-border/70">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
      >
        <span className="text-xs font-medium text-foreground">
          {t(`settings.modelConfig.featureModels.groups.${groupKey}`)}
        </span>
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>
      {expanded ? (
        <div className="space-y-2.5 border-t border-border/70 px-3 py-3">
          {features.map((feature) => (
            <FeatureModelRow
              key={feature.id}
              featureId={feature.id}
              defaultModel={feature.defaultModel}
              requiresVision={Boolean(feature.requiresVision)}
              newApiBaseUrl={newApiBaseUrl}
              database={database}
              configuredProviders={configuredProviders}
              providerChannels={providerChannels}
              savedChannelByProvider={savedChannelByProvider}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function FeatureModelRow({
  featureId,
  defaultModel,
  requiresVision,
  newApiBaseUrl,
  database,
  configuredProviders,
  providerChannels,
  savedChannelByProvider,
}: {
  featureId: string;
  defaultModel: string;
  requiresVision: boolean;
  newApiBaseUrl: string;
  database: NewApiDatabaseConfigInput | undefined;
  configuredProviders: readonly FeatureModelProvider[];
  providerChannels: Record<string, { upstreamKey: string; baseUrl: string }>;
  savedChannelByProvider: Map<string, SavedProviderChannelConfig>;
}) {
  const { t } = useTranslation();
  const entry = useSettingsStore(
    (s) => s.featureModelConfig.featureModels[featureId],
  );
  const updateFeatureModel = useSettingsStore((s) => s.updateFeatureModel);
  const saveChannel = useSaveCustomChannel();
  const configuredSet = useMemo(
    () => new Set(configuredProviders),
    [configuredProviders],
  );
  const fallbackProvider = configuredProviders[0];
  const provider =
    entry?.provider && configuredSet.has(entry.provider)
      ? entry.provider
      : fallbackProvider;
  const model = entry?.model ?? "";

  // 单条保存：仅把该功能拼成一个渠道（modelMapping 只含这一条）写入。
  const handleSaveRow = async () => {
    const m = model.trim();
    if (!m) {
      toast.error(t("settings.modelConfig.featureModels.noMappings"));
      return;
    }
    if (!provider) {
      toast.error(t("settings.modelConfig.featureModels.noChannels"));
      return;
    }
    if (!newApiBaseUrl.trim()) {
      toast.error(t("settings.modelConfig.featureModels.missingBaseUrl"));
      return;
    }
    const channel = providerChannels[provider];
    const upstreamKey = (channel?.upstreamKey ?? "").trim();
    if (!upstreamKey && !savedChannelByProvider.get(provider)?.configured) {
      toast.error(
        t("settings.modelConfig.featureModels.missingKeys", {
          providers: featureProviderLabel(provider),
        }),
      );
      return;
    }
    try {
      const res = await saveChannel.mutateAsync({
        newApiBaseUrl: newApiBaseUrl.trim(),
        ...(database ? { database } : {}),
        provider,
        upstreamKey,
        modelMapping: { [defaultModel]: m },
        group: "default",
        priority: 0,
        weight: 0,
        baseUrl: (channel?.baseUrl ?? "").trim(),
        testModel: "",
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(t("settings.modelConfig.featureModels.savedOne"));
    } catch {
      toast.error(t("settings.modelConfig.requestFailed"));
    }
  };

  return (
    <div className={FEATURE_ROW_GRID}>
      <span className="flex flex-wrap items-center gap-1.5 text-xs text-foreground">
        <span>
          {t(`settings.modelConfig.featureModels.features.${featureId}`)}
        </span>
        {requiresVision ? (
          <span className="rounded border border-amber-400/40 bg-amber-400/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
            {t("settings.modelConfig.featureModels.multimodalRequiredBadge")}
          </span>
        ) : null}
      </span>
      <Select
        value={provider ?? ""}
        onValueChange={(value) =>
          updateFeatureModel(featureId, {
            provider: value as FeatureModelProvider,
          })
        }
        disabled={configuredProviders.length === 0}
      >
        <SelectTrigger size="sm" className="w-full">
          <SelectValue
            placeholder={t(
              "settings.modelConfig.featureModels.noChannelsShort",
            )}
          >
            {(value: string) => featureProviderLabel(value)}
          </SelectValue>
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          {configuredProviders.map((p) => (
            <SelectItem key={p} value={p}>
              {featureProviderLabel(p)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="flex items-center gap-2">
        <Input
          value={model}
          onChange={(e) =>
            updateFeatureModel(featureId, {
              provider: provider ?? fallbackProvider,
              model: e.target.value,
            })
          }
          placeholder={t(
            "settings.modelConfig.featureModels.upstreamModelPlaceholder",
          )}
          className="h-9 flex-1 rounded-md border-input/80 focus-visible:border-ring/70 focus-visible:ring-1 focus-visible:ring-ring/30"
          disabled={configuredProviders.length === 0}
        />
        <Button
          type="button"
          size="sm"
          className="shrink-0"
          onClick={handleSaveRow}
          disabled={saveChannel.isPending || configuredProviders.length === 0}
          title={t("settings.modelConfig.featureModels.saveRow")}
        >
          {saveChannel.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            t("settings.modelConfig.featureModels.saveRow")
          )}
        </Button>
      </div>
    </div>
  );
}

function MediaStorageSection() {
  const { t } = useTranslation();
  const configQuery = useModelGatewayConfig(true);
  const mediaRelay = configQuery.data?.data.mediaRelay;
  const mediaStorage = useSettingsStore((s) => s.mediaStorage);
  const setProvider = useSettingsStore((s) => s.setMediaStorageProvider);
  const updateCloudinary = useSettingsStore(
    (s) => s.updateCloudinaryStorageConfig,
  );
  const updateAliyunOss = useSettingsStore(
    (s) => s.updateAliyunOssStorageConfig,
  );
  const saveMediaRelay = useSaveMediaRelayConfig();

  const { provider, cloudinary, aliyunOss } = mediaStorage;
  const [ttlSeconds, setTtlSeconds] = useState("1800");
  const mediaRelayKey = JSON.stringify(mediaRelay ?? {});
  useEffect(() => {
    if (!mediaRelay) return;
    if (
      mediaRelay.provider === "aliyun_oss" ||
      mediaRelay.provider === "cloudinary"
    ) {
      setProvider(mediaRelay.provider as MediaStorageProvider);
    }
    if (mediaRelay.endpoint || mediaRelay.bucket) {
      updateAliyunOss({
        endpoint: mediaRelay.endpoint || aliyunOss.endpoint,
        bucket: mediaRelay.bucket || aliyunOss.bucket,
        ...(mediaRelay.configured
          ? { accessKeyId: "", accessKeySecret: "" }
          : {}),
      });
    }
    if (mediaRelay.cloudName || mediaRelay.apiFolder) {
      updateCloudinary({
        cloudName: mediaRelay.cloudName || cloudinary.cloudName,
        apiFolder: mediaRelay.apiFolder || cloudinary.apiFolder,
        ...(mediaRelay.provider === "cloudinary" && mediaRelay.configured
          ? { apiKey: "", apiSecret: "" }
          : {}),
      });
    }
    if (mediaRelay.ttlSeconds) {
      setTtlSeconds((current) =>
        current === String(mediaRelay.ttlSeconds)
          ? current
          : String(mediaRelay.ttlSeconds),
      );
    }
    // Full AccessKey values must never be kept after the backend has a saved config.
    // Users re-enter them only when creating/updating the OSS relay credentials.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaRelayKey]);

  const hasConfiguredMediaRelay = Boolean(mediaRelay?.configured);
  const configuredProvider = hasConfiguredMediaRelay
    ? mediaRelay?.provider
    : provider;
  const handleSave = async () => {
    const ttl = Number(ttlSeconds.trim() || "0");
    if (!Number.isFinite(ttl) || ttl <= 0) {
      toast.error(t("settings.mediaStorage.validation.ttlSeconds"));
      return;
    }
    try {
      const res = await saveMediaRelay.mutateAsync(
        provider === "cloudinary"
          ? {
              provider: "cloudinary",
              ttlSeconds: Math.trunc(ttl),
              cloudName: cloudinary.cloudName.trim(),
              apiFolder: cloudinary.apiFolder.trim(),
              ...(cloudinary.apiKey.trim()
                ? { apiKey: cloudinary.apiKey.trim() }
                : {}),
              ...(cloudinary.apiSecret.trim()
                ? { apiSecret: cloudinary.apiSecret.trim() }
                : {}),
            }
          : {
              provider: "aliyun_oss",
              ttlSeconds: Math.trunc(ttl),
              endpoint: aliyunOss.endpoint.trim(),
              bucket: aliyunOss.bucket.trim(),
              ...(aliyunOss.accessKeyId.trim()
                ? { accessKeyId: aliyunOss.accessKeyId.trim() }
                : {}),
              ...(aliyunOss.accessKeySecret.trim()
                ? { accessKeySecret: aliyunOss.accessKeySecret.trim() }
                : {}),
            },
      );
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      if (provider === "cloudinary") {
        updateCloudinary({ apiKey: "", apiSecret: "" });
      } else {
        updateAliyunOss({ accessKeyId: "", accessKeySecret: "" });
      }
      toast.success(
        provider === "cloudinary"
          ? t("settings.mediaStorage.cloudinarySaveSuccess")
          : t("settings.mediaStorage.saveSuccess"),
      );
    } catch (error) {
      toast.error(
        await getRequestErrorMessage(
          error,
          t("settings.mediaStorage.saveFailed"),
        ),
      );
    }
  };

  return (
    <section className="px-5 py-5">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "size-1.5 rounded-full",
            hasConfiguredMediaRelay ? "bg-emerald-400" : "bg-amber-400",
          )}
        />
        <h3 className="font-heading text-sm font-medium text-foreground">
          {t("settings.mediaStorage.title")}
        </h3>
        {!hasConfiguredMediaRelay ? (
          <AlertTriangle
            className="size-3.5 text-amber-400"
            aria-label={t("settings.mediaStorage.warningIconLabel")}
          />
        ) : null}
        <span className="ml-1 rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          {t("settings.mediaStorage.currentPlan")}:{" "}
          {configuredProvider === "cloudinary"
            ? t("settings.mediaStorage.providerCloudinary")
            : t("settings.mediaStorage.providerAliyunOss")}
        </span>
      </div>

      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        {t("settings.mediaStorage.description")}
      </p>

      <p className="mt-3 text-xs text-muted-foreground">
        {t("settings.mediaStorage.status")}:{" "}
        <span
          className={
            hasConfiguredMediaRelay ? "text-emerald-400" : "text-amber-300"
          }
        >
          {hasConfiguredMediaRelay
            ? t("settings.mediaStorage.configured")
            : t("settings.mediaStorage.notConfigured")}
        </span>
        {hasConfiguredMediaRelay && mediaRelay?.source ? (
          <span className="ml-2 text-[11px] text-muted-foreground/80">
            {t("settings.mediaStorage.source", { source: mediaRelay.source })}
          </span>
        ) : null}
      </p>
      {!hasConfiguredMediaRelay ? (
        <div className="mt-3 flex gap-2 rounded-md border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-100">
          <AlertTriangle
            className="mt-0.5 size-3.5 shrink-0 text-amber-300"
            aria-hidden
          />
          <p>{t("settings.mediaStorage.notConfiguredImpact")}</p>
        </div>
      ) : null}

      <div className="mt-4 flex items-center gap-3">
        <span className="w-[64px] shrink-0 text-xs text-muted-foreground">
          {t("settings.mediaStorage.provider")}
        </span>
        <Tabs
          value={provider}
          onValueChange={(value) => setProvider(value as MediaStorageProvider)}
        >
          <TabsList>
            {MEDIA_STORAGE_PROVIDERS.map((p) => (
              <TabsTrigger key={p} value={p}>
                {p === "aliyun_oss"
                  ? t("settings.mediaStorage.providerAliyunOss")
                  : t("settings.mediaStorage.providerCloudinary")}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      <div className="mt-4 space-y-2.5">
        {provider === "cloudinary" ? (
          <CloudinaryFields
            config={cloudinary}
            onChange={updateCloudinary}
            apiKeyPreview={mediaRelay?.cloudinaryApiKeyPreview ?? ""}
            apiSecretPreview={mediaRelay?.cloudinaryApiSecretPreview ?? ""}
          />
        ) : (
          <AliyunOssFields
            config={aliyunOss}
            onChange={updateAliyunOss}
            ttlSeconds={ttlSeconds}
            onTtlSecondsChange={setTtlSeconds}
            accessKeyIdPreview={mediaRelay?.accessKeyIdPreview ?? ""}
            accessKeySecretPreview={mediaRelay?.accessKeySecretPreview ?? ""}
          />
        )}
      </div>

      <div className="mt-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {provider === "cloudinary" ? (
              <>
                {t("settings.mediaStorage.cloudinaryFieldsHint")}{" "}
                <a
                  href="https://cloudinary.com/users/register/free"
                  target="_blank"
                  rel="noreferrer"
                  className="text-cyan-400 hover:text-cyan-300"
                >
                  {t("settings.mediaStorage.cloudinaryRegisterLink")}
                </a>
              </>
            ) : (
              t("settings.mediaStorage.fieldsHint")
            )}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          className="shrink-0"
          onClick={handleSave}
          disabled={saveMediaRelay.isPending || configQuery.isLoading}
        >
          {saveMediaRelay.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : null}
          {provider === "cloudinary"
            ? t("settings.mediaStorage.saveCloudinary")
            : t("settings.mediaStorage.save")}
        </Button>
      </div>
    </section>
  );
}

function CloudinaryFields({
  config,
  onChange,
  apiKeyPreview,
  apiSecretPreview,
}: {
  config: CloudinaryStorageConfig;
  onChange: (patch: Partial<CloudinaryStorageConfig>) => void;
  apiKeyPreview: string;
  apiSecretPreview: string;
}) {
  const { t } = useTranslation();
  return (
    <>
      <FieldRow
        label={t("settings.mediaStorage.fields.cloudName")}
        value={config.cloudName}
        onChange={(v) => onChange({ cloudName: v })}
      />
      <FieldRow
        secret
        name="cloudinary-api-key"
        label={t("settings.mediaStorage.fields.apiKey")}
        value={config.apiKey}
        onChange={(v) => onChange({ apiKey: v })}
        placeholder={apiKeyPreview || undefined}
        savedPreview={apiKeyPreview}
      />
      <FieldRow
        secret
        name="cloudinary-api-secret"
        label={t("settings.mediaStorage.fields.apiSecret")}
        value={config.apiSecret}
        onChange={(v) => onChange({ apiSecret: v })}
        placeholder={apiSecretPreview || undefined}
        savedPreview={apiSecretPreview}
      />
      <FieldRow
        label={t("settings.mediaStorage.fields.apiFolder")}
        value={config.apiFolder}
        onChange={(v) => onChange({ apiFolder: v })}
      />
    </>
  );
}

function AliyunOssFields({
  config,
  onChange,
  ttlSeconds,
  onTtlSecondsChange,
  accessKeyIdPreview,
  accessKeySecretPreview,
}: {
  config: AliyunOssStorageConfig;
  onChange: (patch: Partial<AliyunOssStorageConfig>) => void;
  ttlSeconds: string;
  onTtlSecondsChange: (value: string) => void;
  accessKeyIdPreview: string;
  accessKeySecretPreview: string;
}) {
  const { t } = useTranslation();
  return (
    <>
      <FieldRow
        name="aliyun-oss-access-key-id"
        label={t("settings.mediaStorage.fields.accessKeyId")}
        value={config.accessKeyId}
        onChange={(v) => onChange({ accessKeyId: v })}
        placeholder={accessKeyIdPreview || undefined}
        savedPreview={accessKeyIdPreview}
      />
      <FieldRow
        secret
        name="aliyun-oss-access-key-secret"
        label={t("settings.mediaStorage.fields.accessKeySecret")}
        value={config.accessKeySecret}
        onChange={(v) => onChange({ accessKeySecret: v })}
        placeholder={accessKeySecretPreview || undefined}
        savedPreview={accessKeySecretPreview}
      />
      <FieldRow
        label={t("settings.mediaStorage.fields.bucket")}
        value={config.bucket}
        onChange={(v) => onChange({ bucket: v })}
      />
      <FieldRow
        label={t("settings.mediaStorage.fields.endpoint")}
        value={config.endpoint}
        onChange={(v) => onChange({ endpoint: v })}
      />
      <FieldRow
        label={t("settings.mediaStorage.fields.ttlSeconds")}
        value={ttlSeconds}
        onChange={onTtlSecondsChange}
      />
    </>
  );
}

function FieldRow({
  label,
  value,
  onChange,
  secret = false,
  placeholder,
  name,
  autoComplete,
  savedPreview,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  secret?: boolean;
  placeholder?: string;
  name?: string;
  autoComplete?: string;
  savedPreview?: string;
}) {
  const { t } = useTranslation();
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    if (!value) setRevealed(false);
  }, [value]);
  const hasSavedSecret = Boolean(savedPreview && !value);
  return (
    <div className="grid grid-cols-[120px_1fr] items-center gap-3">
      <Label className="justify-start text-[11px] font-normal tracking-wide text-muted-foreground uppercase">
        {label}
      </Label>
      <div className="relative">
        <Input
          name={name}
          autoComplete={autoComplete ?? (secret ? "new-password" : undefined)}
          type={secret && !revealed ? "password" : "text"}
          value={value}
          placeholder={
            hasSavedSecret
              ? t("settings.secretSavedPlaceholder", { preview: savedPreview })
              : placeholder
          }
          onChange={(e) => onChange(e.target.value)}
          className={cn(
            "h-9 rounded-md border-input/80 focus-visible:border-ring/70 focus-visible:ring-1 focus-visible:ring-ring/30",
            secret && value && "pr-9",
            hasSavedSecret && "pr-16",
          )}
        />
        {secret && value ? (
          <button
            type="button"
            onClick={() => setRevealed((r) => !r)}
            aria-label={
              revealed
                ? t("settings.mediaStorage.hideSecret")
                : t("settings.mediaStorage.showSecret")
            }
            className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
          >
            {revealed ? (
              <EyeOff className="size-4" />
            ) : (
              <Eye className="size-4" />
            )}
          </button>
        ) : hasSavedSecret ? (
          <span className="absolute top-1/2 right-2 -translate-y-1/2 rounded bg-emerald-400/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">
            {t("settings.secretSavedBadge")}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function CodexBridgeSection() {
  const { t } = useTranslation();
  return (
    <section className="px-5 py-5">
      <div className="flex items-center gap-2">
        <span className="size-1.5 rounded-full bg-emerald-400" />
        <h3 className="font-heading text-sm font-medium text-foreground">
          {t("settings.codexBridge.title")}
        </h3>
        <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          {t("settings.codexBridge.badge")}
        </span>
      </div>

      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        {t("settings.codexBridge.description")}
      </p>

      <div className="mt-3 space-y-2 text-xs">
        <div className="flex items-center gap-3">
          <span className="w-[48px] shrink-0 text-muted-foreground">
            {t("settings.codexBridge.statusLabel")}
          </span>
          <span className="inline-flex items-center gap-1.5 text-emerald-400">
            <span className="size-1.5 rounded-full bg-emerald-400" />
            {t("settings.codexBridge.statusConnected")}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="w-[48px] shrink-0 text-muted-foreground">
            {t("settings.codexBridge.authLabel")}
          </span>
          <span className="text-foreground">
            {t("settings.codexBridge.authReady")}
          </span>
        </div>
      </div>
    </section>
  );
}
