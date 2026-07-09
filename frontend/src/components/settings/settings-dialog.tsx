// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  AlertTriangle,
  ChevronDown,
  Eye,
  EyeOff,
  Loader2,
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  FEATURE_MODEL_GROUPS,
  type FeatureModelDef,
  type FeatureModelGroup,
} from "@/lib/feature-models";
import {
  useModelGatewayConfig,
  useEnableOfficial,
  useSaveOfficialConfig,
  useInitCustomNewApi,
  useSaveCustomChannel,
  useSaveCustomChannelsBatch,
  useSaveEmbeddingModel,
  useSaveMediaModels,
  useSaveProviderChannels,
  useSaveMediaRelayConfig,
  useSyncProviderChannel,
  type GatewayMode,
  type ModelGatewayConfig,
  type CustomChannelInput,
  type NewApiDatabaseConfigInput,
  type SavedEmbeddingModelConfig,
  type SavedProviderChannelConfig,
} from "@/lib/queries/model-gateway";
import {
  useSettingsStore,
  FEATURE_MODEL_PROVIDERS,
  type AliyunOssStorageConfig,
  type CloudinaryStorageConfig,
  type EmbeddingModelEntry,
  type FeatureModelProvider,
  type MediaStorageProvider,
} from "@/stores/settingsStore";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const MEDIA_STORAGE_PROVIDERS: MediaStorageProvider[] = ["aliyun_oss", "cloudinary"];

// Codex 本地桥接暂时隐藏（保留组件代码，后端就绪后改回 true 即可恢复）。
const SHOW_CODEX_BRIDGE = false;

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const { t } = useTranslation();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton
        className="max-w-[calc(100%-2rem)] gap-0 rounded-lg border border-border bg-black p-0 ring-0 sm:max-w-[860px]"
      >
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle>{t("settings.title")}</DialogTitle>
        </DialogHeader>

        <ScrollArea className="max-h-[min(72vh,640px)] [&_[data-slot=scroll-area-scrollbar]]:!w-1 [&_[data-slot=scroll-area-scrollbar]]:!border-l-0 [&_[data-slot=scroll-area-scrollbar]]:!p-0">
          <div className="divide-y divide-border">
            <ModelConfigSection open={open} />
            <MediaStorageSection />
            {SHOW_CODEX_BRIDGE && <CodexBridgeSection />}
          </div>
        </ScrollArea>

        <div className="flex justify-end border-t border-border px-5 py-3.5">
          <DialogClose render={<Button variant="outline" size="sm" />}>
            {t("settings.close")}
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const GATEWAY_MODES: GatewayMode[] = ["official", "custom"];

const DEFAULT_CUSTOM_NEWAPI_URL = "http://127.0.0.1:3000";

async function getRequestErrorMessage(error: unknown, fallback: string): Promise<string> {
  const response = (error as { response?: Response } | null)?.response;
  if (response) {
    const body = await response.clone().json().catch(() => null);
    if (body && typeof body === "object") {
      const data = body as { detail?: unknown; error?: unknown; message?: unknown };
      for (const value of [data.detail, data.error, data.message]) {
        if (typeof value === "string" && value.trim()) return value.trim();
      }
    }
    const text = await response.clone().text().catch(() => "");
    if (text.trim()) return text.trim();
  }
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" && message.trim() ? message.trim() : fallback;
}

function getResponseErrorMessage(response: unknown, fallback: string): string {
  if (response && typeof response === "object") {
    const data = response as { detail?: unknown; error?: unknown; message?: unknown };
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
        ) as
          | { error?: unknown }
          | undefined;
        if (typeof failed?.error === "string" && failed.error.trim()) {
          return failed.error.trim();
        }
      }
    }
    if (Array.isArray(data.detail)) {
      const first = data.detail.find((item) => item && typeof item === "object") as
        | { msg?: unknown }
        | undefined;
      if (typeof first?.msg === "string" && first.msg.trim()) return first.msg.trim();
    }
  }
  return fallback;
}

function ModelConfigSection({ open }: { open: boolean }) {
  const { t } = useTranslation();
  const configQuery = useModelGatewayConfig(open);
  const config = configQuery.data?.data;
  const loading = configQuery.isLoading;
  const modelGatewayMissing = config ? !config.effective.configured : false;

  const [mode, setMode] = useState<GatewayMode>("official");
  // 配置加载后，把激活的 tab 同步到服务端当前 mode。
  const serverMode = config?.mode;
  useEffect(() => {
    if (serverMode) {
      setMode((current) => (current === serverMode ? current : serverMode));
    }
  }, [serverMode]);

  // 自定义 NewAPI 地址上提到此处：自定义面板的输入框与下方「保存映射」
  // 写入渠道时共用同一个 newApiBaseUrl。
  const [customBaseUrl, setCustomBaseUrl] = useState(DEFAULT_CUSTOM_NEWAPI_URL);
  const [dbSqlDsn, setDbSqlDsn] = useState("");
  const [dbSqlitePath, setDbSqlitePath] = useState("");
  const [dbAdminUsername, setDbAdminUsername] = useState("root");
  const seededCustomBaseUrl = config?.custom?.adminBaseUrl || config?.custom?.baseUrl || "";
  useEffect(() => {
    if (seededCustomBaseUrl) {
      setCustomBaseUrl((current) =>
        current === seededCustomBaseUrl ? current : seededCustomBaseUrl,
      );
    }
  }, [seededCustomBaseUrl]);

  const databaseStatus = config?.provisioner?.database;
  const databaseStatusKey = JSON.stringify(databaseStatus ?? {});
  useEffect(() => {
    if (!databaseStatus) return;
    const preview = databaseStatus.sqlDsnPreview || "";
    if (preview) {
      setDbSqlDsn((current) => {
        if (preview.includes("***")) return "";
        return current === preview ? current : preview;
      });
    }
    if (databaseStatus.sqlitePath) {
      setDbSqlitePath((current) =>
        current === databaseStatus.sqlitePath ? current : databaseStatus.sqlitePath,
      );
    }
    if (databaseStatus.adminUsername) {
      setDbAdminUsername((current) =>
        current === databaseStatus.adminUsername ? current : databaseStatus.adminUsername,
      );
    }
  }, [databaseStatusKey]);

  const customDatabase = useMemo<NewApiDatabaseConfigInput | undefined>(() => {
    const sqlDsn = dbSqlDsn.trim();
    const sqlitePath = dbSqlitePath.trim();
    const adminUsername = dbAdminUsername.trim();
    if (!sqlDsn && !sqlitePath && (!adminUsername || adminUsername === "root")) {
      return undefined;
    }
    return {
      ...(sqlDsn ? { sqlDsn } : {}),
      ...(sqlitePath ? { sqlitePath } : {}),
      ...(adminUsername ? { adminUsername } : {}),
    };
  }, [dbSqlDsn, dbSqlitePath, dbAdminUsername]);

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
              channel: t(`settings.modelConfig.modes.${config.effective.source}`, {
                defaultValue: config.effective.source,
              }),
            })}
          </span>
        ) : null}
      </div>

      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        {t("settings.modelConfig.description")}
      </p>
      {modelGatewayMissing ? (
        <div className="mt-3 flex gap-2 rounded-md border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-100">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-300" aria-hidden />
          <p>{t("settings.modelConfig.gatewayNotConfiguredImpact")}</p>
        </div>
      ) : null}

      <Tabs
        className="mt-4"
        value={mode}
        onValueChange={(value) => setMode(value as GatewayMode)}
      >
        <TabsList>
          {GATEWAY_MODES.map((m) => (
            <TabsTrigger key={m} value={m}>
              {t(`settings.modelConfig.modes.${m}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="mt-4">
        {mode === "official" ? (
          <OfficialGatewayPanel config={config} loading={loading} />
        ) : (
          <CustomGatewayPanel
            config={config}
            loading={loading}
            baseUrl={customBaseUrl}
            onBaseUrlChange={setCustomBaseUrl}
            dbSqlDsn={dbSqlDsn}
            onDbSqlDsnChange={setDbSqlDsn}
            dbSqlitePath={dbSqlitePath}
            onDbSqlitePathChange={setDbSqlitePath}
            dbAdminUsername={dbAdminUsername}
            onDbAdminUsernameChange={setDbAdminUsername}
            database={customDatabase}
          />
        )}
      </div>

      {/* 功能模型映射仅在自定义渠道展示；官方渠道不需要。 */}
      {mode === "custom" ? (
        <FeatureModelsBlock
          newApiBaseUrl={customBaseUrl}
          database={customDatabase}
          savedProviderChannels={config?.provisioner?.providerChannels ?? []}
          savedEmbeddingModel={config?.provisioner?.embeddingModel}
          savedMediaModels={config?.provisioner?.mediaModels ?? {}}
        />
      ) : null}
    </section>
  );
}

function OfficialGatewayPanel({
  config,
  loading,
}: {
  config: ModelGatewayConfig | undefined;
  loading: boolean;
}) {
  const { t } = useTranslation();
  const official = config?.official;
  const enableOfficial = useEnableOfficial();
  const saveOfficial = useSaveOfficialConfig();

  const [apiKey, setApiKey] = useState("");
  const [revealKey, setRevealKey] = useState(false);

  const handleSave = async () => {
    const trimmedApiKey = apiKey.trim();
    try {
      if (!trimmedApiKey) {
        if (!official?.configured) {
          toast.error(t("settings.modelConfig.official.missingFields"));
          return;
        }
        const response = await enableOfficial.mutateAsync();
        if (!response.ok) {
          toast.error(getResponseErrorMessage(response, t("settings.modelConfig.requestFailed")));
          return;
        }
        toast.success(t("settings.modelConfig.official.saved"));
        return;
      }
      const response = await saveOfficial.mutateAsync({
        newApiApiKey: trimmedApiKey,
      });
      if (!response.ok) {
        toast.error(getResponseErrorMessage(response, t("settings.modelConfig.requestFailed")));
        return;
      }
      setApiKey("");
      toast.success(t("settings.modelConfig.official.saved"));
    } catch (error) {
      toast.error(await getRequestErrorMessage(error, t("settings.modelConfig.requestFailed")));
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

      <div className="space-y-2.5">
        <div className="grid grid-cols-[120px_1fr] items-center gap-3">
          <Label className="justify-start text-[11px] font-normal tracking-wide text-muted-foreground uppercase">
            {t("settings.modelConfig.fields.apiKey")}
          </Label>
          <div className="relative">
            <Input
              type={revealKey ? "text" : "password"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={official?.configured ? official.apiKeyPreview : "sk-..."}
              className="h-9 rounded-md border-input/80 pr-9 focus-visible:border-ring/70 focus-visible:ring-1 focus-visible:ring-ring/30"
            />
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
              {revealKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
        </div>
      </div>

      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          onClick={handleSave}
          disabled={loading || saveOfficial.isPending || enableOfficial.isPending}
        >
          {saveOfficial.isPending || enableOfficial.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : null}
          {t("settings.modelConfig.official.save")}
        </Button>
      </div>
    </div>
  );
}

function CustomGatewayPanel({
  config,
  loading,
  baseUrl,
  onBaseUrlChange,
  dbSqlDsn,
  onDbSqlDsnChange,
  dbSqlitePath,
  onDbSqlitePathChange,
  dbAdminUsername,
  onDbAdminUsernameChange,
  database,
}: {
  config: ModelGatewayConfig | undefined;
  loading: boolean;
  baseUrl: string;
  onBaseUrlChange: (value: string) => void;
  dbSqlDsn: string;
  onDbSqlDsnChange: (value: string) => void;
  dbSqlitePath: string;
  onDbSqlitePathChange: (value: string) => void;
  dbAdminUsername: string;
  onDbAdminUsernameChange: (value: string) => void;
  database: NewApiDatabaseConfigInput | undefined;
}) {
  const { t } = useTranslation();
  const initCustom = useInitCustomNewApi();
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
      message.includes("setupUsername") || message.includes("NewAPI is not initialized")
        ? t("settings.modelConfig.custom.setupRequired")
        : message;
    showInitError(displayMessage);
  };

  const handleInit = async () => {
    setInitError("");
    setInitNotice("");
    const trimmedSetupPassword = setupPassword.trim();
    const trimmedSetupConfirmPassword = setupConfirmPassword.trim();
    const hasSetupPassword = Boolean(trimmedSetupPassword || trimmedSetupConfirmPassword);
    const setupUsername = dbAdminUsername.trim();
    if (hasSetupPassword && !setupUsername) {
      showInitError(t("settings.modelConfig.custom.setupPasswordMissingUsername"));
      return;
    }
    if (hasSetupPassword && (!trimmedSetupPassword || !trimmedSetupConfirmPassword)) {
      showInitError(t("settings.modelConfig.custom.setupPasswordIncomplete"));
      return;
    }
    if (hasSetupPassword && trimmedSetupPassword.length < 8) {
      showInitError(t("settings.modelConfig.custom.setupPasswordTooShort"));
      return;
    }
    if (hasSetupPassword && trimmedSetupPassword !== trimmedSetupConfirmPassword) {
      showInitError(t("settings.modelConfig.custom.setupPasswordMismatch"));
      return;
    }

    try {
      const response = await initCustom.mutateAsync(
        {
          ...(baseUrl.trim() ? { newApiBaseUrl: baseUrl.trim() } : {}),
          ...(database ? { database } : {}),
          ...(hasSetupPassword
            ? {
                setupUsername,
                setupPassword: trimmedSetupPassword,
                setupConfirmPassword: trimmedSetupConfirmPassword,
              }
            : {}),
        },
      );
      if (response.ok !== true) {
        showInitResponseError(
          getResponseErrorMessage(response, t("settings.modelConfig.requestFailed")),
        );
        return;
      }
      const passwordIgnored =
        hasSetupPassword && response.data.newApiSetup?.alreadyInitialized === true;
      setSetupPassword("");
      setSetupConfirmPassword("");
      if (passwordIgnored) {
        setInitNotice(t("settings.modelConfig.custom.setupAlreadyInitializedPasswordIgnored"));
      }
      toast.success(t("settings.modelConfig.custom.initialized"));
    } catch (error) {
      const message = await getRequestErrorMessage(error, t("settings.modelConfig.requestFailed"));
      showInitResponseError(message);
    }
  };

  const databaseStatus = config?.provisioner?.database;
  const databaseConfigured = Boolean(databaseStatus?.configured);
  const sqlDsnPreview = databaseStatus?.sqlDsnPreview || "";
  const sqlDsnPlaceholder = sqlDsnPreview || "local";

  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t("settings.modelConfig.custom.description")}
      </p>

      <div className="space-y-2.5">
        <FieldRow
          label={t("settings.modelConfig.fields.baseUrl")}
          value={baseUrl}
          onChange={onBaseUrlChange}
          placeholder={DEFAULT_CUSTOM_NEWAPI_URL}
        />
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {t("settings.modelConfig.baseUrlHint")}
        </p>
      </div>

      <div className="rounded-md border border-border/70 p-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            {t("settings.modelConfig.custom.databaseTitle")}
          </p>
          <span className={cn("text-[11px]", databaseConfigured ? "text-emerald-400" : "text-muted-foreground")}>
            {databaseConfigured
              ? t("settings.modelConfig.custom.databaseConfigured")
              : t("settings.modelConfig.custom.databaseNotConfigured")}
          </span>
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
          {t("settings.modelConfig.custom.databaseDescription")}
        </p>
        <div className="mt-3 space-y-2.5">
          <FieldRow
            label={t("settings.modelConfig.fields.sqlDsn")}
            value={dbSqlDsn}
            onChange={onDbSqlDsnChange}
            placeholder={sqlDsnPlaceholder}
          />
          <FieldRow
            label={t("settings.modelConfig.fields.sqlitePath")}
            value={dbSqlitePath}
            onChange={onDbSqlitePathChange}
            placeholder="/path/to/new-api/one-api.db"
          />
          <FieldRow
            label={t("settings.modelConfig.fields.adminUsername")}
            value={dbAdminUsername}
            onChange={onDbAdminUsernameChange}
            placeholder="root"
          />
        </div>
      </div>

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
            label={t("settings.modelConfig.custom.setupPassword")}
            value={setupPassword}
            onChange={setSetupPassword}
            placeholder={t("settings.modelConfig.custom.setupPasswordPlaceholder")}
          />
          <FieldRow
            secret
            label={t("settings.modelConfig.custom.setupConfirmPassword")}
            value={setupConfirmPassword}
            onChange={setSetupConfirmPassword}
            placeholder={t("settings.modelConfig.custom.setupConfirmPasswordPlaceholder")}
          />
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          {t("settings.modelConfig.custom.setupPasswordOnlyOnce")}
        </p>
        {initError ? (
          <p
            role="alert"
            aria-live="polite"
            className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] leading-relaxed text-destructive"
          >
            {initError}
          </p>
        ) : null}
        {!initError && initNotice ? (
          <p
            role="status"
            aria-live="polite"
            className="mt-2 rounded-md border border-amber-400/35 bg-amber-400/10 px-3 py-2 text-[11px] leading-relaxed text-amber-200"
          >
            {initNotice}
          </p>
        ) : null}
      </div>

      <div className="flex justify-end">
        <Button type="button" size="sm" onClick={handleInit} disabled={loading || initCustom.isPending}>
          {initCustom.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {t("settings.modelConfig.custom.init")}
        </Button>
      </div>
    </div>
  );
}

// 功能模型映射每行的三列栅格：功能 | 供应商 | 模型名称。表头与行共用同一模板以对齐。
const FEATURE_ROW_GRID =
  "grid grid-cols-[minmax(0,1fr)_150px_minmax(0,1fr)] items-center gap-3";

function splitFeatureModelGroups(predicate: (feature: FeatureModelDef) => boolean): FeatureModelGroup[] {
  return FEATURE_MODEL_GROUPS.map((group) => ({
    ...group,
    features: group.features.filter(predicate),
  })).filter((group) => group.features.length > 0);
}

const MEDIA_MODEL_ROWS: readonly {
  model: string;
  kind: "image" | "video" | "audio";
  officialOnly?: boolean;
}[] = [
  { model: "gpt-image-2", kind: "image" },
  { model: "nano-banana-2", kind: "image" },
  { model: "seedance-1.0-pro-fast", kind: "video" },
  { model: "seedance-1.5-pro", kind: "video" },
  { model: "seedance-2.0", kind: "video" },
  { model: "seedance-2.0-fast", kind: "video" },
  { model: "happyhorse-1.0", kind: "video" },
  { model: "grok-video-channel", kind: "video" },
  { model: "index-tts-2", kind: "audio" },
  { model: "eleven-music", kind: "audio" },
  { model: "seedance-2.0-value", kind: "video", officialOnly: true },
  { model: "seedance-2.0-fast-value", kind: "video", officialOnly: true },
];

const MEDIA_ROW_GRID =
  "grid grid-cols-[90px_minmax(0,1fr)_150px_minmax(0,1fr)] items-center gap-3";

const EMBEDDING_INTERNAL_MODEL = "DC-cognee-embedding";
const DEFAULT_EMBEDDING_DIMENSION = 1024;
const DEFAULT_EMBEDDING_BATCH_SIZE = 10;

const FEATURE_PROVIDER_LABELS: Record<FeatureModelProvider, string> = {
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
  '360': "360",
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


function FeatureModelsBlock({
  newApiBaseUrl,
  database,
  savedProviderChannels,
  savedEmbeddingModel,
  savedMediaModels,
}: {
  newApiBaseUrl: string;
  database: NewApiDatabaseConfigInput | undefined;
  savedProviderChannels: SavedProviderChannelConfig[];
  savedEmbeddingModel: SavedEmbeddingModelConfig | undefined;
  savedMediaModels: Record<string, { provider: string; upstreamModel: string }>;
}) {
  const { t } = useTranslation();
  const featureModels = useSettingsStore((s) => s.featureModelConfig.featureModels);
  const providerChannels = useSettingsStore((s) => s.featureModelConfig.providerChannels);
  const saveBatch = useSaveCustomChannelsBatch();
  const addFeatureProviderChannel = useSettingsStore((s) => s.addFeatureProviderChannel);
  const updateFeatureProviderChannel = useSettingsStore((s) => s.updateFeatureProviderChannel);

  const configuredProviders = useMemo(
    () => FEATURE_MODEL_PROVIDERS.filter((p) => Boolean(providerChannels[p])),
    [providerChannels],
  );
  const textFeatureGroups = useMemo(
    () => splitFeatureModelGroups((feature) => !feature.requiresVision),
    [],
  );
  const visionFeatureGroups = useMemo(
    () => splitFeatureModelGroups((feature) => Boolean(feature.requiresVision)),
    [],
  );
  const savedChannelByProvider = useMemo(() => {
    return new Map(savedProviderChannels.map((channel) => [channel.provider, channel]));
  }, [savedProviderChannels]);

  const savedProviderChannelsKey = JSON.stringify(savedProviderChannels);
  const lastSyncedProviderChannelsKey = useRef("");
  useEffect(() => {
    if (lastSyncedProviderChannelsKey.current === savedProviderChannelsKey) return;
    lastSyncedProviderChannelsKey.current = savedProviderChannelsKey;
    for (const channel of savedProviderChannels) {
      if (!FEATURE_MODEL_PROVIDERS.includes(channel.provider as FeatureModelProvider)) continue;
      const provider = channel.provider as FeatureModelProvider;
      const current = useSettingsStore.getState().featureModelConfig.providerChannels?.[provider];
      const savedBaseUrl = channel.baseUrl ?? "";
      if (!current) {
        addFeatureProviderChannel(provider);
        if (savedBaseUrl) {
          updateFeatureProviderChannel(provider, { baseUrl: savedBaseUrl });
        }
        continue;
      }
      if (current.baseUrl !== savedBaseUrl && !current.upstreamKey) {
        updateFeatureProviderChannel(provider, { baseUrl: savedBaseUrl });
      }
    }
  }, [addFeatureProviderChannel, savedProviderChannels, savedProviderChannelsKey, updateFeatureProviderChannel]);

  // 把功能行按 provider 分组拼成渠道：modelMapping = { DC内部模型名: 上游模型名 }。
  const buildChannels = (): CustomChannelInput[] => {
    const byProvider = new Map<FeatureModelProvider, Record<string, string>>();
    for (const group of FEATURE_MODEL_GROUPS) {
      for (const feature of group.features) {
        const entry = featureModels[feature.id];
        if (!entry || !entry.model.trim() || !providerChannels[entry.provider]) continue;
        const mapping = byProvider.get(entry.provider) ?? {};
        mapping[feature.defaultModel] = entry.model.trim();
        byProvider.set(entry.provider, mapping);
      }
    }
    return [...byProvider.entries()].map(([provider, modelMapping]) => {
      const channel = providerChannels[provider];
      return {
        provider,
        upstreamKey: (channel?.upstreamKey ?? "").trim(),
        modelMapping,
        group: "default",
        priority: 0,
        weight: 0,
        baseUrl: (channel?.baseUrl ?? "").trim(),
        testModel: "",
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
        if (c.upstreamKey) return false;
        return !savedChannelByProvider.get(c.provider)?.configured;
      })
      .map((c) => FEATURE_PROVIDER_LABELS[c.provider as FeatureModelProvider]);
    if (missing.length > 0) {
      toast.error(
        t("settings.modelConfig.featureModels.missingKeys", { providers: missing.join("、") }),
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
          t("settings.modelConfig.featureModels.savedPartial", { succeeded, failed }),
        );
      } else {
        toast.success(t("settings.modelConfig.featureModels.saved", { count: succeeded }));
      }
    } catch {
      toast.error(t("settings.modelConfig.requestFailed"));
    }
  };

  return (
    <>
      <ProviderChannelsBlock
        savedProviderChannels={savedProviderChannels}
        newApiBaseUrl={newApiBaseUrl}
        database={database}
      />

      {/* 功能模型映射 */}
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
        title={t("settings.modelConfig.featureModels.multimodalModelsTitle")}
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
          {saveBatch.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {t("settings.modelConfig.featureModels.save")}
        </Button>
      </div>

      <EmbeddingModelBlock
        configuredProviders={configuredProviders}
        newApiBaseUrl={newApiBaseUrl}
        database={database}
        savedChannelByProvider={savedChannelByProvider}
        savedEmbeddingModel={savedEmbeddingModel}
      />

      <MediaModelsBlock
        configuredProviders={configuredProviders}
        newApiBaseUrl={newApiBaseUrl}
        database={database}
        savedChannelByProvider={savedChannelByProvider}
        savedMediaModels={savedMediaModels}
      />
    </>
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
  const localSavedEmbeddingModel = useSettingsStore((s) => s.featureModelConfig.embeddingModel);
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
  const dimension = localModel?.dimension ?? DEFAULT_EMBEDDING_DIMENSION;
  const batchSize =
    localModel === undefined ? DEFAULT_EMBEDDING_BATCH_SIZE : localModel.batchSize;

  const updateLocal = (patch: Partial<EmbeddingModelEntry>) => {
    setLocalModel((prev) => ({
      provider: patch.provider ?? prev?.provider ?? configuredProviders[0] ?? "ali",
      upstreamModel: patch.upstreamModel ?? prev?.upstreamModel ?? "",
      dimension: patch.dimension ?? prev?.dimension ?? DEFAULT_EMBEDDING_DIMENSION,
      batchSize:
        "batchSize" in patch
          ? patch.batchSize
          : prev?.batchSize ?? DEFAULT_EMBEDDING_BATCH_SIZE,
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
        providers: FEATURE_PROVIDER_LABELS[provider],
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
    const normalizedDimension = Math.round(Number(dimension));
    if (!Number.isFinite(normalizedDimension) || normalizedDimension <= 0) {
      toast.error(t("settings.modelConfig.embeddingModel.invalidDimension"));
      return;
    }
    const normalizedBatchSize =
      batchSize == null || String(batchSize).trim() === "" ? undefined : Math.round(Number(batchSize));
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
        const message = getResponseErrorMessage(res, t("settings.modelConfig.requestFailed"));
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
      const message = await getRequestErrorMessage(error, t("settings.modelConfig.requestFailed"));
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
        <div className="grid grid-cols-[minmax(0,1fr)_140px_minmax(0,1fr)_100px_110px] items-center gap-3 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          <span>{t("settings.modelConfig.embeddingModel.colInternalModel")}</span>
          <span>{t("settings.modelConfig.embeddingModel.colProvider")}</span>
          <span>{t("settings.modelConfig.embeddingModel.colUpstreamModel")}</span>
          <span>{t("settings.modelConfig.embeddingModel.colDimension")}</span>
          <span>{t("settings.modelConfig.embeddingModel.colBatchSize")}</span>
        </div>
        <div className="mt-2 grid grid-cols-[minmax(0,1fr)_140px_minmax(0,1fr)_100px_110px] items-center gap-3">
          <code className="truncate rounded border border-border/60 bg-white/[0.03] px-2 py-1.5 text-[11px] text-muted-foreground">
            {EMBEDDING_INTERNAL_MODEL}
          </code>
          <Select
            value={selectedProvider}
            onValueChange={(provider) => updateLocal({ provider: provider as FeatureModelProvider })}
            disabled={configuredProviders.length === 0}
          >
            <SelectTrigger size="sm" className="w-full">
              <SelectValue placeholder={t("settings.modelConfig.embeddingModel.defaultProvider")}>
                {(provider: string) => FEATURE_PROVIDER_LABELS[provider as FeatureModelProvider]}
              </SelectValue>
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              {configuredProviders.map((provider) => (
                <SelectItem key={provider} value={provider}>
                  {FEATURE_PROVIDER_LABELS[provider]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            value={upstreamModel}
            onChange={(event) => updateLocal({ upstreamModel: event.target.value })}
            placeholder={t("settings.modelConfig.embeddingModel.upstreamModelPlaceholder")}
            className="h-8 rounded-md border-input/80 focus-visible:border-ring/70 focus-visible:ring-1 focus-visible:ring-ring/30"
            disabled={configuredProviders.length === 0}
          />
          <Input
            value={String(dimension)}
            onChange={(event) => updateLocal({ dimension: Number(event.target.value) })}
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
                batchSize: event.target.value.trim() ? Number(event.target.value) : undefined,
              })
            }
            inputMode="numeric"
            min={1}
            step={1}
            type="number"
            placeholder={t("settings.modelConfig.embeddingModel.batchSizePlaceholder")}
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
          disabled={configuredProviders.length === 0 || saveEmbeddingModel.isPending}
        >
          {saveEmbeddingModel.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {t("settings.modelConfig.embeddingModel.save")}
        </Button>
      </div>
    </div>
  );
}

function MediaModelsBlock({
  configuredProviders,
  newApiBaseUrl,
  database,
  savedChannelByProvider,
  savedMediaModels,
}: {
  configuredProviders: readonly FeatureModelProvider[];
  newApiBaseUrl: string;
  database: NewApiDatabaseConfigInput | undefined;
  savedChannelByProvider: Map<string, SavedProviderChannelConfig>;
  savedMediaModels: Record<string, { provider: string; upstreamModel: string }>;
}) {
  const { t } = useTranslation();
  const localSavedMediaModels = useSettingsStore((s) => s.featureModelConfig.mediaModels ?? {});
  const setMediaModels = useSettingsStore((s) => s.setMediaModels);
  const saveMediaModels = useSaveMediaModels();
  const [mediaModels, setLocalMediaModels] = useState(localSavedMediaModels);
  const [saveError, setSaveError] = useState("");
  const savedMediaModelsKey = JSON.stringify(savedMediaModels);
  const localSavedMediaModelsKey = JSON.stringify(localSavedMediaModels);

  useEffect(() => {
    const fromBackend = Object.fromEntries(
      Object.entries(savedMediaModels).map(([model, entry]) => [
        model,
        {
          provider: entry.provider as FeatureModelProvider,
          upstreamModel: entry.upstreamModel,
        },
      ]),
    );
    const next = Object.keys(fromBackend).length > 0 ? fromBackend : localSavedMediaModels;
    const nextKey = JSON.stringify(next ?? {});
    setLocalMediaModels((current) =>
      JSON.stringify(current ?? {}) === nextKey ? current : (next ?? {}),
    );
  }, [localSavedMediaModelsKey, savedMediaModelsKey]);

  const handleSave = async () => {
    setSaveError("");
    const next: typeof localSavedMediaModels = {};
    for (const row of MEDIA_MODEL_ROWS) {
      if (row.officialOnly) continue;
      const entry = mediaModels[row.model];
      if (entry?.provider && configuredProviders.includes(entry.provider)) {
        next[row.model] = {
          provider: entry.provider,
          upstreamModel: entry.upstreamModel.trim(),
        };
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
          .filter((provider) => !savedChannelByProvider.get(provider)?.configured),
      ),
    );
    if (missingProviders.length > 0) {
      const message = t("settings.modelConfig.featureModels.missingKeys", {
        providers: missingProviders
          .map((provider) => FEATURE_PROVIDER_LABELS[provider])
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
      const res = await saveMediaModels.mutateAsync({
        newApiBaseUrl: newApiBaseUrl.trim(),
        ...(database ? { database } : {}),
        models: next,
      });
      if (!res.ok) {
        const message = getResponseErrorMessage(res, t("settings.modelConfig.requestFailed"));
        setSaveError(message);
        toast.error(message);
        return;
      }
      const { succeeded, failed, models, results } = res.data;
      if (failed > 0) {
        const firstError = results.find((item) => item.error)?.error;
        const message = firstError ||
          t("settings.modelConfig.featureModels.savedPartial", { succeeded, failed });
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
          },
        ]),
      );
      setMediaModels(saved);
      setLocalMediaModels(saved);
      toast.success(t("settings.modelConfig.mediaModels.saved"));
    } catch (error) {
      const message = await getRequestErrorMessage(error, t("settings.modelConfig.requestFailed"));
      setSaveError(message);
      toast.error(message);
    }
  };

  return (
    <div className="mt-6">
      <h4 className="text-xs font-medium text-foreground">
        {t("settings.modelConfig.mediaModels.title")}
      </h4>
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
        {t("settings.modelConfig.mediaModels.description")}
      </p>

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
      </div>

      <div className="mt-2 rounded-md border border-border/70">
        {MEDIA_MODEL_ROWS.map((row, index) => {
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
                        provider: provider as FeatureModelProvider,
                        upstreamModel: prev[row.model]?.upstreamModel ?? "",
                      },
                    }))
                  }
                  disabled={configuredProviders.length === 0}
                >
                  <SelectTrigger size="sm" className="w-full">
                    <SelectValue placeholder={t("settings.modelConfig.mediaModels.defaultProvider")}>
                      {(provider: string) => FEATURE_PROVIDER_LABELS[provider as FeatureModelProvider]}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    {configuredProviders.map((provider) => (
                      <SelectItem key={provider} value={provider}>
                        {FEATURE_PROVIDER_LABELS[provider]}
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
                        provider: prev[row.model]?.provider ?? configuredProviders[0] ?? "ali",
                        upstreamModel: event.target.value,
                      },
                    }))
                  }
                  placeholder={t("settings.modelConfig.mediaModels.upstreamModelPlaceholder", {
                    model: row.model,
                  })}
                  className="h-8 rounded-md border-input/80 focus-visible:border-ring/70 focus-visible:ring-1 focus-visible:ring-ring/30"
                  disabled={configuredProviders.length === 0}
                />
              )}
            </div>
          );
        })}
      </div>

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
          disabled={configuredProviders.length === 0 || saveMediaModels.isPending}
        >
          {saveMediaModels.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {t("settings.modelConfig.mediaModels.save")}
        </Button>
      </div>
    </div>
  );
}

function ProviderChannelsBlock({
  savedProviderChannels,
  newApiBaseUrl,
  database,
}: {
  savedProviderChannels: SavedProviderChannelConfig[];
  newApiBaseUrl: string;
  database: NewApiDatabaseConfigInput | undefined;
}) {
  const { t } = useTranslation();
  const providerChannels = useSettingsStore((s) => s.featureModelConfig.providerChannels);
  const addFeatureProviderChannel = useSettingsStore((s) => s.addFeatureProviderChannel);
  const saveProviderChannels = useSaveProviderChannels();

  const configuredProviders = useMemo(
    () => FEATURE_MODEL_PROVIDERS.filter((p) => Boolean(providerChannels[p])),
    [providerChannels],
  );
  const availableProviders = FEATURE_MODEL_PROVIDERS.filter((p) => !providerChannels[p]);
  const savedChannelByProvider = useMemo(() => {
    return new Map(savedProviderChannels.map((channel) => [channel.provider, channel]));
  }, [savedProviderChannels]);
  const [selectedProvider, setSelectedProvider] = useState<FeatureModelProvider>(
    availableProviders[0] ?? FEATURE_MODEL_PROVIDERS[0],
  );

  useEffect(() => {
    if (!availableProviders.includes(selectedProvider) && availableProviders[0]) {
      setSelectedProvider(availableProviders[0]);
    }
  }, [availableProviders, selectedProvider]);

  const handleAdd = () => {
    if (!availableProviders.includes(selectedProvider)) return;
    addFeatureProviderChannel(selectedProvider);
  };

  const handleSaveChannels = () => {
    if (configuredProviders.length === 0) {
      toast.error(t("settings.modelConfig.featureModels.noChannels"));
      return;
    }
    const channelsToSave = configuredProviders
      .filter((provider) => {
        if ((providerChannels[provider]?.upstreamKey ?? "").trim()) return true;
        return Boolean(savedChannelByProvider.get(provider)?.configured);
      })
      .map((provider) => ({
        provider,
        upstreamKey: (providerChannels[provider]?.upstreamKey ?? "").trim() || undefined,
        baseUrl: (providerChannels[provider]?.baseUrl ?? "").trim(),
      }));
    if (channelsToSave.length === 0) {
      toast.error(
        t("settings.modelConfig.featureModels.missingKeys", {
          providers: configuredProviders.map((provider) => FEATURE_PROVIDER_LABELS[provider]).join("、"),
        }),
      );
      return;
    }
    saveProviderChannels.mutate(
      {
        channels: channelsToSave,
      },
      {
        onSuccess: (res) => {
          if (!res.ok) {
            toast.error(res.error);
            return;
          }
          for (const { provider } of channelsToSave) {
            if ((providerChannels[provider]?.upstreamKey ?? "").trim()) {
              useSettingsStore.getState().clearFeatureProviderUpstreamKey(provider);
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
            onValueChange={(value) => setSelectedProvider(value as FeatureModelProvider)}
            disabled={availableProviders.length === 0}
          >
            <SelectTrigger size="sm" className="min-w-[170px] flex-1">
              <SelectValue>
                {(value: string) => FEATURE_PROVIDER_LABELS[value as FeatureModelProvider]}
              </SelectValue>
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              {availableProviders.map((p) => (
                <SelectItem key={p} value={p}>
                  {FEATURE_PROVIDER_LABELS[p]}
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
            disabled={availableProviders.length === 0}
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
              {saveProviderChannels.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
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
  savedChannel,
  newApiBaseUrl,
  database,
}: {
  provider: FeatureModelProvider;
  savedChannel: SavedProviderChannelConfig | undefined;
  newApiBaseUrl: string;
  database: NewApiDatabaseConfigInput | undefined;
}) {
  const { t } = useTranslation();
  const channel = useSettingsStore((s) => s.featureModelConfig.providerChannels[provider]);
  const updateFeatureProviderChannel = useSettingsStore((s) => s.updateFeatureProviderChannel);
  const removeFeatureProviderChannel = useSettingsStore((s) => s.removeFeatureProviderChannel);
  const clearFeatureProviderUpstreamKey = useSettingsStore((s) => s.clearFeatureProviderUpstreamKey);
  const syncProviderChannel = useSyncProviderChannel();
  const [revealed, setRevealed] = useState(false);
  const upstreamKeyValue = channel?.upstreamKey ?? "";
  const savedKeyPreview = savedChannel?.configured ? savedChannel.upstreamKeyPreview : "";
  const upstreamPlaceholder = savedKeyPreview || "sk-...";
  const handleSync = async () => {
    if (!newApiBaseUrl.trim()) {
      toast.error(t("settings.modelConfig.featureModels.missingBaseUrl"));
      return;
    }
    const upstreamKey = upstreamKeyValue.trim();
    if (!upstreamKey && !savedChannel?.configured) {
      toast.error(
        t("settings.modelConfig.featureModels.missingKeys", {
          providers: FEATURE_PROVIDER_LABELS[provider],
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
        toast.error(getResponseErrorMessage(res, t("settings.modelConfig.requestFailed")));
        return;
      }
      if (upstreamKey) {
        clearFeatureProviderUpstreamKey(provider);
      }
      toast.success(t("settings.modelConfig.featureModels.channelSynced"));
    } catch (error) {
      toast.error(await getRequestErrorMessage(error, t("settings.modelConfig.requestFailed")));
    }
  };

  return (
    <div className="grid gap-2 rounded-md border border-border/60 p-2.5 sm:grid-cols-[130px_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
      <div>
        <Label className="justify-start text-[11px] font-normal text-muted-foreground">
          {t("settings.modelConfig.featureModels.channelProvider")}
        </Label>
        <div className="mt-1.5 h-9 rounded-md border border-border/70 bg-white/[0.03] px-3 py-2 text-xs text-foreground">
          {FEATURE_PROVIDER_LABELS[provider]}
        </div>
      </div>
      <div>
        <Label className="justify-start text-[11px] font-normal text-muted-foreground">
          {t("settings.modelConfig.featureModels.upstreamKey")}
        </Label>
        <div className="relative mt-1.5">
          <Input
            type={revealed ? "text" : "password"}
            value={upstreamKeyValue}
            onChange={(e) => updateFeatureProviderChannel(provider, { upstreamKey: e.target.value })}
            placeholder={upstreamPlaceholder}
            className="h-9 rounded-md border-input/80 pr-9 focus-visible:border-ring/70 focus-visible:ring-1 focus-visible:ring-ring/30"
          />
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
            {revealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
      </div>
      <div>
        <Label className="justify-start text-[11px] font-normal text-muted-foreground">
          {t("settings.modelConfig.featureModels.baseUrlOverride")}
        </Label>
        <Input
          value={channel?.baseUrl ?? ""}
          onChange={(e) => updateFeatureProviderChannel(provider, { baseUrl: e.target.value })}
          placeholder={t("settings.modelConfig.featureModels.baseUrlPlaceholder")}
          className="mt-1.5 h-9 rounded-md border-input/80 focus-visible:border-ring/70 focus-visible:ring-1 focus-visible:ring-ring/30"
        />
      </div>
      <div className="flex items-center justify-end gap-1.5 sm:self-end">
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
      t("settings.modelConfig.featureModels.bulkApplied", { count: featureCount }),
    );
  };

  return (
    <div className="mt-4">
      <h5 className="text-[11px] font-medium text-foreground">{title}</h5>
      {hint ? (
        <p className="mt-1 text-[11px] leading-relaxed text-amber-300/80">{hint}</p>
      ) : null}
      <div className="mt-2 grid grid-cols-[150px_minmax(0,1fr)_auto] items-center gap-2 rounded-md border border-border/70 px-3 py-2">
        <Select
          value={bulkProvider}
          onValueChange={(value) => setBulkProvider(value as FeatureModelProvider)}
          disabled={configuredProviders.length === 0}
        >
          <SelectTrigger size="sm" className="w-full">
            <SelectValue placeholder={t("settings.modelConfig.featureModels.noChannelsShort")}>
              {(value: string) => FEATURE_PROVIDER_LABELS[value as FeatureModelProvider]}
            </SelectValue>
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            {configuredProviders.map((provider) => (
              <SelectItem key={provider} value={provider}>
                {FEATURE_PROVIDER_LABELS[provider]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          value={bulkModel}
          onChange={(event) => setBulkModel(event.target.value)}
          placeholder={t("settings.modelConfig.featureModels.bulkModelPlaceholder")}
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
  newApiBaseUrl,
  database,
  configuredProviders,
  providerChannels,
  savedChannelByProvider,
}: {
  featureId: string;
  defaultModel: string;
  newApiBaseUrl: string;
  database: NewApiDatabaseConfigInput | undefined;
  configuredProviders: readonly FeatureModelProvider[];
  providerChannels: Record<string, { upstreamKey: string; baseUrl: string }>;
  savedChannelByProvider: Map<string, SavedProviderChannelConfig>;
}) {
  const { t } = useTranslation();
  const entry = useSettingsStore((s) => s.featureModelConfig.featureModels[featureId]);
  const updateFeatureModel = useSettingsStore((s) => s.updateFeatureModel);
  const saveChannel = useSaveCustomChannel();
  const configuredSet = useMemo(() => new Set(configuredProviders), [configuredProviders]);
  const fallbackProvider = configuredProviders[0];
  const provider = entry?.provider && configuredSet.has(entry.provider) ? entry.provider : fallbackProvider;
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
          providers: FEATURE_PROVIDER_LABELS[provider],
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
      <span className="text-xs text-foreground">
        {t(`settings.modelConfig.featureModels.features.${featureId}`)}
      </span>
      <Select
        value={provider ?? ""}
        onValueChange={(value) =>
          updateFeatureModel(featureId, { provider: value as FeatureModelProvider })
        }
        disabled={configuredProviders.length === 0}
      >
        <SelectTrigger size="sm" className="w-full">
          <SelectValue placeholder={t("settings.modelConfig.featureModels.noChannelsShort")}>
            {(value: string) => FEATURE_PROVIDER_LABELS[value as FeatureModelProvider]}
          </SelectValue>
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          {configuredProviders.map((p) => (
            <SelectItem key={p} value={p}>
              {FEATURE_PROVIDER_LABELS[p]}
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
          placeholder={t("settings.modelConfig.featureModels.upstreamModelPlaceholder")}
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
  const updateCloudinary = useSettingsStore((s) => s.updateCloudinaryStorageConfig);
  const updateAliyunOss = useSettingsStore((s) => s.updateAliyunOssStorageConfig);
  const saveMediaRelay = useSaveMediaRelayConfig();

  const { provider, cloudinary, aliyunOss } = mediaStorage;
  const [ttlSeconds, setTtlSeconds] = useState("1800");
  const mediaRelayKey = JSON.stringify(mediaRelay ?? {});
  useEffect(() => {
    if (!mediaRelay) return;
    if (mediaRelay.provider === "aliyun_oss" || mediaRelay.provider === "cloudinary") {
      setProvider(mediaRelay.provider as MediaStorageProvider);
    }
    if (mediaRelay.endpoint || mediaRelay.bucket) {
      updateAliyunOss({
        endpoint: mediaRelay.endpoint || aliyunOss.endpoint,
        bucket: mediaRelay.bucket || aliyunOss.bucket,
        ...(mediaRelay.configured ? { accessKeyId: "", accessKeySecret: "" } : {}),
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
        current === String(mediaRelay.ttlSeconds) ? current : String(mediaRelay.ttlSeconds),
      );
    }
    // Full AccessKey values must never be kept after the backend has a saved config.
    // Users re-enter them only when creating/updating the OSS relay credentials.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaRelayKey]);

  const hasConfiguredMediaRelay = Boolean(mediaRelay?.configured);
  const configuredProvider = hasConfiguredMediaRelay ? mediaRelay?.provider : provider;
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
              apiKey: cloudinary.apiKey.trim(),
              apiSecret: cloudinary.apiSecret.trim(),
              apiFolder: cloudinary.apiFolder.trim(),
            }
          : {
              provider: "aliyun_oss",
              ttlSeconds: Math.trunc(ttl),
              endpoint: aliyunOss.endpoint.trim(),
              bucket: aliyunOss.bucket.trim(),
              accessKeyId: aliyunOss.accessKeyId.trim(),
              accessKeySecret: aliyunOss.accessKeySecret.trim(),
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
      toast.error(await getRequestErrorMessage(error, t("settings.mediaStorage.saveFailed")));
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
          {t("settings.mediaStorage.currentPlan")}: {configuredProvider === "cloudinary"
            ? t("settings.mediaStorage.providerCloudinary")
            : t("settings.mediaStorage.providerAliyunOss")}
        </span>
      </div>

      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        {t("settings.mediaStorage.description")}
      </p>

      <p className="mt-3 text-xs text-muted-foreground">
        {t("settings.mediaStorage.status")}: {" "}
        <span className={hasConfiguredMediaRelay ? "text-emerald-400" : "text-amber-300"}>
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
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-300" aria-hidden />
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
            {provider === "cloudinary"
              ? (
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
              )
              : t("settings.mediaStorage.fieldsHint")}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          className="shrink-0"
          onClick={handleSave}
          disabled={saveMediaRelay.isPending || configQuery.isLoading}
        >
          {saveMediaRelay.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
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
        label={t("settings.mediaStorage.fields.apiKey")}
        value={config.apiKey}
        onChange={(v) => onChange({ apiKey: v })}
        placeholder={apiKeyPreview || undefined}
      />
      <FieldRow
        secret
        allowReveal={false}
        label={t("settings.mediaStorage.fields.apiSecret")}
        value={config.apiSecret}
        onChange={(v) => onChange({ apiSecret: v })}
        placeholder={apiSecretPreview || undefined}
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
        label={t("settings.mediaStorage.fields.accessKeyId")}
        value={config.accessKeyId}
        onChange={(v) => onChange({ accessKeyId: v })}
        placeholder={accessKeyIdPreview || undefined}
      />
      <FieldRow
        secret
        allowReveal={false}
        label={t("settings.mediaStorage.fields.accessKeySecret")}
        value={config.accessKeySecret}
        onChange={(v) => onChange({ accessKeySecret: v })}
        placeholder={accessKeySecretPreview || undefined}
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
  allowReveal = true,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  secret?: boolean;
  allowReveal?: boolean;
  placeholder?: string;
}) {
  const { t } = useTranslation();
  const [revealed, setRevealed] = useState(false);
  return (
    <div className="grid grid-cols-[120px_1fr] items-center gap-3">
      <Label className="justify-start text-[11px] font-normal tracking-wide text-muted-foreground uppercase">
        {label}
      </Label>
      <div className="relative">
        <Input
          type={secret && !revealed ? "password" : "text"}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className={cn(
            "h-9 rounded-md border-input/80 focus-visible:border-ring/70 focus-visible:ring-1 focus-visible:ring-ring/30",
            secret && "pr-9",
          )}
        />
        {secret && allowReveal ? (
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
            {revealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
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
          <span className="text-foreground">{t("settings.codexBridge.authReady")}</span>
        </div>
      </div>
    </section>
  );
}
